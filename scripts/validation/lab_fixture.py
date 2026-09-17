#!/usr/bin/env python3
"""DISPOSABLE Linux lab only. Creates fixture data, never a production auth bypass.

Run in an isolated VM with a database named sidey_validation. Generated credentials
stay in mode-0600 files; no provider credentials are used. Re-running resets nothing.
"""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import subprocess
import time
import uuid

def private(path, value):
    with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as stream:
        stream.write(value)


def initialize(directory):
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "secrets").mkdir(exist_ok=True)
    if (directory / "server.env").exists():
        raise RuntimeError("Lab already initialized")
    values = {
        "SIDEY_DATABASE_URL": "jdbc:postgresql://127.0.0.1:55433/sidey_validation",
        "SIDEY_DATABASE_USER": "sidey_validation",
        "SIDEY_DATABASE_PASSWORD": secrets.token_urlsafe(32),
        "SIDEY_JWT_SECRET": base64.b64encode(secrets.token_bytes(32)).decode(),
        "SIDEY_INVITE_PEPPER": base64.b64encode(secrets.token_bytes(32)).decode(),
        "SIDEY_DEPLOYMENT_KEY": secrets.token_urlsafe(32),
    }
    private(directory / "server.env", "".join(f"{k}={v}\n" for k, v in values.items()))
    private(directory / "deployment.key", values["SIDEY_DEPLOYMENT_KEY"])
    private(directory / "postgres.env", "POSTGRES_DB=sidey_validation\nPOSTGRES_USER=sidey_validation\nPOSTGRES_PASSWORD=" + values["SIDEY_DATABASE_PASSWORD"] + "\n")


def seed(directory, count):
    values = dict(line.split("=", 1) for line in (directory / "server.env").read_text().splitlines())
    assert values["SIDEY_DATABASE_URL"] == "jdbc:postgresql://127.0.0.1:55433/sidey_validation"
    sql = ["begin;"]
    fixtures = []
    room = None
    for index in range(count):
        user, sid = str(uuid.uuid4()), str(uuid.uuid4())
        if index % 12 == 0:
            room = str(uuid.uuid4())
        sql += [f"insert into users(id,status) values ('{user}','ACTIVE');",
                f"insert into user_identities(user_id,provider,provider_subject) values ('{user}','GOOGLE','lab-{user}');",
                f"insert into profiles(id,nickname) values ('{user}','Lab{index}');",
                f"insert into user_sessions(id,user_id,refresh_token_hash,created_at,last_refreshed_at,expires_at,absolute_expires_at,device_platform) values ('{sid}','{user}',decode('{secrets.token_hex(32)}','hex'),now(),now(),now()+interval '1 day',now()+interval '180 days','OTHER');"]
        if index % 12 == 0:
            sql.append(f"insert into rooms(id,name,owner_id) values ('{room}','Lab room','{user}');")
        sql.append(f"insert into room_members(room_id,user_id) values ('{room}','{user}');")
        fixtures.append({"user": user, "sid": sid, "room": room})
    sql.append("commit;")
    subprocess.run(["psql", "-h", "127.0.0.1", "-p", "55433", "-U", "sidey_validation", "-d", "sidey_validation", "-v", "ON_ERROR_STOP=1", "-q"],
                   input="\n".join(sql), text=True, check=True,
                   env={**os.environ, "PGPASSWORD": values["SIDEY_DATABASE_PASSWORD"]}, stdout=subprocess.DEVNULL)
    private(directory / "fixtures.json", json.dumps(fixtures))
    tokens(directory)
    print(json.dumps({"fixture_users": count, "database": "sidey_validation"}))


def tokens(directory):
    values = dict(line.split("=", 1) for line in (directory / "server.env").read_text().splitlines())
    fixtures = json.loads((directory / "fixtures.json").read_text())
    for fixture in fixtures:
        fixture["token"] = issue(values, fixture)
    private(directory / "tokens.json", json.dumps(fixtures))


def issue(values, fixture):
    key = base64.b64decode(values["SIDEY_JWT_SECRET"])
    def encode(value):
        return base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":")).encode()).decode().rstrip("=")
    now = int(time.time())
    data = encode({"alg": "HS256", "typ": "JWT"}) + "." + encode({"iss": "sidey", "aud": ["sidey-api"], "sub": fixture["user"], "sid": fixture["sid"], "iat": now, "exp": now + 900})
    return data + "." + base64.urlsafe_b64encode(hmac.new(key, data.encode(), hashlib.sha256).digest()).decode().rstrip("=")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["initialize", "seed", "tokens"])
    parser.add_argument("directory", type=Path)
    parser.add_argument("--count", type=int, default=3300)
    args = parser.parse_args()
    if args.action == "initialize":
        initialize(args.directory)
    elif args.action == "seed":
        seed(args.directory, args.count)
    else:
        tokens(args.directory)
