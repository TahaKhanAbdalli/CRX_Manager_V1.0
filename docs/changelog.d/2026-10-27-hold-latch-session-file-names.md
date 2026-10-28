## 2026-10-27 - Hold files keep case-different and numeric session ids apart

- From the third Luna review of PR #1152: only a lowercase `[a-z0-9_-]` string session id names its hold file as-is. Any other id (uppercase, which Windows' case-insensitive disk would fold onto a lowercase twin, a number, or other characters) is hashed together with its type, so `"ABC"` and `"abc"`, or `0` and `"0"`, do not share a file (short of a 128-bit hash collision). Tests now pass a numeric id through the hook, and the guard's header comment names all three file forms.
