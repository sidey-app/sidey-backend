#!/usr/bin/env python3
"""Verify the released send_message RPC remains one six-field JSON object."""

from __future__ import annotations

import argparse
import json
import re
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any


EXPECTED_KEYS = {
    "id", "room_id", "sender_id", "body", "created_at", "bubble_style_id"
}
UUID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


class VerificationError(RuntimeError):
    pass


def request_json(url: str, api_key: str, body: dict[str, Any], token: str | None = None) -> Any:
    headers = {"apikey": api_key, "content-type": "application/json"}
    if token is not None:
        headers["authorization"] = f"Bearer {token}"
    request = urllib.request.Request(
        url,
        data=json.dumps(body, separators=(",", ":")).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.load(response)
    except (urllib.error.URLError, json.JSONDecodeError) as error:
        raise VerificationError(f"HTTP request failed for {url}: {error}") from error


def validate_legacy_response(payload: Any, message_id: str, body: str) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise VerificationError(
            f"send_message envelope must be one JSON object, got {type(payload).__name__}"
        )
    if set(payload) != EXPECTED_KEYS:
        raise VerificationError(f"send_message keys drifted: {sorted(payload)}")
    for key in ("id", "room_id", "sender_id"):
        if not isinstance(payload[key], str) or UUID.fullmatch(payload[key]) is None:
            raise VerificationError(f"send_message.{key} must be a UUID string")
    if payload["id"].lower() != message_id.lower() or payload["body"] != body:
        raise VerificationError("send_message response does not match the request")
    if not isinstance(payload["created_at"], str) or "T" not in payload["created_at"]:
        raise VerificationError("send_message.created_at must be an ISO timestamp string")
    if payload["bubble_style_id"] is not None and not isinstance(
        payload["bubble_style_id"], str
    ):
        raise VerificationError("send_message.bubble_style_id must be string or null")
    return payload


def verify(base_url: str, api_key: str, email: str, password: str) -> dict[str, Any]:
    base = base_url.rstrip("/")
    auth = request_json(
        f"{base}/auth/v1/token?{urllib.parse.urlencode({'grant_type': 'password'})}",
        api_key,
        {"email": email, "password": password},
    )
    token = auth.get("access_token") if isinstance(auth, dict) else None
    if not isinstance(token, str):
        raise VerificationError("local test user login did not return an access token")
    request_json(
        f"{base}/rest/v1/rpc/upsert_profile",
        api_key,
        {"p_nickname": "레거시응답", "p_character_id": "pixel_hamster"},
        token,
    )
    room = request_json(
        f"{base}/rest/v1/rpc/create_room",
        api_key,
        {"p_name": "레거시 응답 검증"},
        token,
    )
    if not isinstance(room, list) or len(room) != 1 or not UUID.fullmatch(
        str(room[0].get("room_id", ""))
    ):
        raise VerificationError("create_room did not return one room fixture")
    message_id = str(uuid.uuid4())
    body = "legacy object envelope"
    payload = request_json(
        f"{base}/rest/v1/rpc/send_message",
        api_key,
        {"p_id": message_id, "p_room_id": room[0]["room_id"], "p_body": body},
        token,
    )
    return validate_legacy_response(payload, message_id, body)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--api-key", required=True)
    parser.add_argument("--email", required=True)
    parser.add_argument("--password", required=True)
    args = parser.parse_args()
    try:
        payload = verify(args.url, args.api_key, args.email, args.password)
    except VerificationError as error:
        print(f"legacy PostgREST verification failed: {error}")
        return 1
    print("legacy PostgREST response verified: object keys=" + ",".join(sorted(payload)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
