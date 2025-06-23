#!/bin/bash

# Conventional commit prefixes
readonly PREFIXES="build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test"

# Read commit message from file
readonly COMMIT_MSG=$(head -1 "$1")

# Check if it's a conventional commit
if echo "$COMMIT_MSG" | grep -qE "^(${PREFIXES})(\([a-z0-9-]+\))?(!)?: .+"; then
    echo "✅ Valid conventional commit: $COMMIT_MSG"
    exit 0
elif echo "$COMMIT_MSG" | grep -qE "^(Merge|Revert|Initial commit)"; then
    echo "✅ Valid merge/revert/initial commit: $COMMIT_MSG"
    exit 0
else
    echo "✖ Invalid commit message: $COMMIT_MSG"
    echo ""
    echo "Please use conventional commit format:"
    echo "  <type>(<scope>)?(!)?: <description>"
    echo ""
    echo "Types: $PREFIXES"
    echo "Examples:"
    echo "  feat: add new feature"
    echo "  fix(auth): resolve login issue"
    echo "  feat!: breaking change"
    echo "  Merge branch 'feature'"
    exit 1
fi 