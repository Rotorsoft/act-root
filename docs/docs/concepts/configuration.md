# Configuration

## Background

Configuration management is essential for adapting your application to different environments and operational requirements. The Act Framework provides structured mechanisms for managing environment variables, configuration files, and logging settings. By centralizing configuration, you can ensure consistency, simplify deployment, and make it easier to manage changes across development, testing, and production environments.

## Environment Setup

- Use environment variables to control runtime behavior (e.g., database URLs, log levels, feature flags).
- Support for `.env` files and configuration objects is built-in.
- Separate configuration for development, testing, and production is recommended.

## Configuration Files

- Store sensitive or environment-specific settings outside of source control.
- Use configuration files for complex or hierarchical settings.

## Logging

- Structured logging and debugging tools are provided to help you monitor and troubleshoot your application.
- Log levels can be controlled via environment variables.
- Use logs for auditing, debugging, and monitoring in production.

## Best Practices

- Centralize configuration and avoid hardcoding values.
- Use environment variables for secrets and deployment-specific settings.
- Regularly review and rotate secrets and credentials.

[API Reference (act)](../api/act.src)
