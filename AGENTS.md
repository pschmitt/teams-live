# Agent notes

`teams-live` is a real-time Microsoft Teams daemon with GitLab, Jira, and
OpsGenie integrations.

- Use `just check` and `just build` to validate code changes. Keep live-service
  integrations behind test credentials or mocks when testing behavior.
- Before changing workflows, check for reusable workflows or actions in
  [ci-workflows](https://github.com/pschmitt/ci-workflows) and preserve
  existing triggers, parameters, and check coverage.
