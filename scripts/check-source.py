#!/usr/bin/env python3
"""Small deterministic guardrails, separate from compile and PostgreSQL tests."""
from pathlib import Path
import sys

errors = []
for path in Path("src/main").rglob("*"):
    if not path.is_file():
        continue
    text = path.read_text()
    if path.suffix == ".sql":
        for forbidden in ("auth.uid()", "auth.role()", "realtime.send(", "enable row level security", "notify pgrst"):
            if forbidden in text.lower():
                errors.append(f"{path}: forbidden Supabase plumbing {forbidden}")
    if path.suffix == ".java":
        for forbidden in ("org.hibernate", "jakarta.persistence", "org.h2", "org.springframework.data.redis"):
            if forbidden in text:
                errors.append(f"{path}: forbidden dependency {forbidden}")
    for line_number, line in enumerate(text.splitlines(), 1):
        if line.rstrip() != line:
            errors.append(f"{path}:{line_number}: trailing whitespace")
if errors:
    print("\n".join(errors))
    sys.exit(1)
print("Source guardrails passed")
