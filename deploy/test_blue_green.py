import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("blue_green", Path(__file__).with_name("blue_green.py"))
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)


class FakeHost:
    def __init__(self, old="blue"):
        self.old = old
        self.states = {"blue": old == "blue", "green": False}
        self.events = []
        self.fail_activate = False
        self.fail_route = False
        self.fail_candidate_drain = False
        self.pending_old = False
        self.other_running = False

    def active(self):
        return self.old

    def running(self, slot):
        return self.other_running

    def ready(self, slot):
        self.events.append(("ready", slot))

    def control(self, slot, action):
        self.events.append((action, slot))
        if action == "drain":
            if slot == "green" and self.fail_candidate_drain:
                raise OSError("unknown candidate state")
            self.states[slot] = False
        elif action == "activate":
            assert not self.states["green" if slot == "blue" else "blue"], "two active JVMs"
            self.states[slot] = True
            if slot == "green" and self.fail_activate:
                raise OSError("response lost after commit")
        return {"accepting": self.states[slot], "inFlight": 1 if slot == "blue" and self.pending_old else 0, "connections": 0}

    def route(self, slot):
        self.events.append(("route", slot))
        if slot == "green" and self.fail_route:
            raise OSError("nginx validation/reload failure")
        self.old = slot

    def stop(self, slot):
        self.events.append(("stop", slot))
        assert not self.states[slot]


class SwitchTests(unittest.TestCase):
    def test_old_is_quiescent_before_new_activation_and_proxy_switch(self):
        host = FakeHost()
        deployment.switch(host, "green")
        self.assertEqual(host.events, [("ready", "green"), ("status", "green"), ("drain", "blue"),
                                      ("activate", "green"), ("route", "green"), ("stop", "blue")])
        self.assertEqual(host.states, {"blue": False, "green": True})

    def test_lost_activation_response_is_not_treated_as_failed_activation(self):
        host = FakeHost()
        host.fail_activate = True
        with self.assertRaises(RuntimeError):
            deployment.switch(host, "green")
        self.assertEqual(host.states, {"blue": True, "green": False})
        self.assertLess(host.events.index(("drain", "green")), host.events.index(("activate", "blue")))

    def test_uncertain_candidate_cannot_reactivate_old_instance(self):
        host = FakeHost()
        host.fail_activate = host.fail_candidate_drain = True
        with self.assertRaisesRegex(RuntimeError, "safe active"):
            deployment.switch(host, "green")
        self.assertNotIn(("activate", "blue"), host.events)
        self.assertFalse(host.states["blue"])

    def test_proxy_failure_rolls_back_after_candidate_drains(self):
        host = FakeHost()
        host.fail_route = True
        with self.assertRaises(RuntimeError):
            deployment.switch(host, "green")
        self.assertEqual(host.old, "blue")
        self.assertEqual(host.states, {"blue": True, "green": False})

    def test_pending_old_transaction_prevents_new_activation(self):
        host = FakeHost()
        host.pending_old = True
        with self.assertRaises(RuntimeError):
            deployment.switch(host, "green")
        self.assertNotIn(("activate", "green"), host.events)

    def test_bootstrap_requires_explicit_flag_and_no_other_running_slot(self):
        host = FakeHost(None)
        with self.assertRaises(RuntimeError):
            deployment.switch(host, "blue")
        host.other_running = True
        with self.assertRaises(RuntimeError):
            deployment.switch(host, "blue", bootstrap=True)
        host.other_running = False
        deployment.switch(host, "blue", bootstrap=True)
        self.assertEqual(host.states, {"blue": True, "green": False})

    def test_existing_active_candidate_is_never_adopted_silently(self):
        host = FakeHost()
        host.states["green"] = True
        with self.assertRaises(RuntimeError):
            deployment.switch(host, "green")
        self.assertNotIn(("drain", "blue"), host.events)


if __name__ == "__main__":
    unittest.main()
