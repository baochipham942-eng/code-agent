# Security Configuration Examples

This directory contains example configurations for the Code Agent security module.

## Files

- `security-config.json` - Complete security configuration example

## Configuration Options

### Audit Logging

All tool executions are logged to JSONL files for audit purposes.

```json
{
  "security": {
    "auditLog": {
      "enabled": true,
      "retentionDays": 30
    }
  }
}
```

**Log Location:** `~/.code-agent/audit/YYYY-MM-DD.jsonl`

### Sensitive Information Detection

Automatically detects and masks sensitive information in logs.

Built-in patterns:
- API Keys
- AWS Credentials
- GitHub Tokens
- Private Keys
- Passwords
- Database URLs

Add custom patterns:

```json
{
  "security": {
    "sensitiveDetection": {
      "enabled": true,
      "customPatterns": [
        {
          "name": "my-internal-key",
          "pattern": "MY_KEY_[A-Z0-9]{16}",
          "description": "My internal API keys"
        }
      ]
    }
  }
}
```

### Command Monitoring

Block or warn on dangerous commands.

```json
{
  "security": {
    "commandMonitor": {
      "blockedPatterns": ["rm -rf /"],
      "warningPatterns": ["sudo"]
    }
  }
}
```

## Usage

1. Copy `security-config.json` to your project's `.claude/settings.json`
2. Modify patterns as needed
3. Restart Code Agent

## Querying Audit Logs

```bash
# View today's logs
cat ~/.code-agent/audit/$(date +%Y-%m-%d).jsonl | jq .

# Search for specific tool usage
cat ~/.code-agent/audit/*.jsonl | jq 'select(.toolName == "bash")'

# Find security incidents
cat ~/.code-agent/audit/*.jsonl | jq 'select(.securityFlags != null)'
```
