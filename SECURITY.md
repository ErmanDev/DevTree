# Security policy

DevTree runs git commands on your computer, so we take security reports seriously.

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately through GitHub's
[private vulnerability reporting](https://github.com/ErmanDev/DevTree/security/advisories/new) for this repository.

Include:

- what you found and what an attacker could do with it,
- how to reproduce it,
- the DevTree version (`devtree --help` or the release you downloaded) and your operating system.

You'll get a reply as soon as possible. Once a fix is released, the advisory is published and you're credited, unless you'd rather not be.

## Supported versions

Security fixes go into the latest release. Please update to it before reporting.

## How DevTree protects you

See [Security & privacy](https://devtree-4594d.web.app/docs/security) for the threat model: a loopback-only server, request guards, no shell, in-memory credentials and no telemetry.
