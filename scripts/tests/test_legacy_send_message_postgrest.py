import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "supabase"))

from verify_legacy_send_message_postgrest import (  # noqa: E402
    VerificationError,
    validate_legacy_response,
)


class LegacySendMessagePostgrestTests(unittest.TestCase):
    def setUp(self):
        self.message_id = "30000000-0000-4000-8000-000000000001"
        self.payload = {
            "id": self.message_id,
            "room_id": "20000000-0000-4000-8000-000000000001",
            "sender_id": "10000000-0000-4000-8000-000000000001",
            "body": "legacy object envelope",
            "created_at": "2026-09-22T00:00:00+00:00",
            "bubble_style_id": None,
        }

    def test_accepts_exact_macos_database_message_object(self):
        self.assertEqual(
            validate_legacy_response(
                self.payload, self.message_id, "legacy object envelope"
            ),
            self.payload,
        )

    def test_rejects_array_envelope_or_additive_sequence(self):
        with self.assertRaises(VerificationError):
            validate_legacy_response(
                [self.payload], self.message_id, "legacy object envelope"
            )
        with self.assertRaises(VerificationError):
            validate_legacy_response(
                {**self.payload, "sequence": 1},
                self.message_id,
                "legacy object envelope",
            )


if __name__ == "__main__":
    unittest.main()
