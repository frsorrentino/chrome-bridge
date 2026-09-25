# Security

If you found a way for chrome-bridge to read or write outside its perimeter, expose a secret, run code that was not
asked for, or send data off the computer, please report it privately — not in a public issue.

- **GitHub private vulnerability reporting** (preferred): open
  https://github.com/frsorrentino/chrome-bridge/security/advisories/new and describe what you saw. Only the
  maintainers read it.
- From a session with the plugin installed, `/chrome-bridge:observe send --security` prepares the anonymized report
  for you and sends it there after your yes; the observations it marks `--security` never enter a public issue.

You will get an answer in the advisory itself. Fixed versions are noted in the CHANGELOG.
