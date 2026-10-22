# Contributing to Artifact Explorer Plugin

Thank you for your interest in contributing to the Artifact Explorer Jenkins Plugin!

## Reporting Issues
Please report bugs and feature requests via [GitHub Issues](https://github.com/jenkinsci/artifact-explorer-plugin/issues).

## Development Setup
This plugin is built with Maven and Java 21+ using the modern Jenkins Plugin Parent POM.

### Building Locally
```bash
mvn clean verify
```

### Running Tests
```bash
mvn test
```

### Checking Code Quality & Security (SpotBugs & Spotless)
```bash
mvn spotbugs:check
mvn spotless:check
```

### Interactive Development Instance
To launch a live interactive Jenkins development instance with the plugin pre-installed:
```bash
mvn hpi:run
```
Then navigate to `http://localhost:8080/jenkins/`.

## Code & Design Guidelines
- **Zero Emojis**: The plugin strictly adheres to professional Jenkins UI design standards. Use standard SVG icons and clean typography.
- **Security**: All HTTP endpoints enforce standard Jenkins permissions (`Run.ARTIFACTS` or `Item.READ`). User paths are strictly sanitized to prevent directory traversal. Rendered markdown and sandboxed HTML views enforce Content Security Policy (CSP).
- **Zero Build Step**: Front-end JavaScript and CSS are standard vanilla ES2022 and native CSS variables without Node/Webpack build steps.

## Submitting Pull Requests
1. Fork the repository and create a descriptive feature branch.
2. Verify all JUnit 5 tests pass and SpotBugs reports 0 bugs.
3. Open a pull request against the `master` branch.
4. Continuous Delivery will automatically release merged pull requests using JEP-229.
