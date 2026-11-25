# Security

Please report security problems privately through GitHub's "Report a vulnerability" button on the
Security tab of this repository, not in a public issue. Include the steps to reproduce and what an
attacker could do. We reply within a week.

Tidegate runs other people's agent code. The runner's default mode runs agents as local processes and
is meant for code you trust; use `tidegate runner --isolate docker` for anything else.
