# TypeScript Best Practices

## Type Safety & Configuration
- Enable strict mode with additional flags: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`
- Never use `any`; use `unknown` if type skipping is necessary and narrow the type later
- Never use `// @ts-ignore` or `// @ts-expect-error` without a detailed explanatory comment
- Always define return types for functions
- Avoid TypeScript Enums; use union types or string literal types instead
- Use `readonly` modifiers for immutable arrays and objects
- Use generic types for reusable components

## Advanced Patterns
- Leverage utility types: `Partial`, `Pick`, `Omit`, `Record`
- Use discriminated unions with exhaustiveness checking for complex object handling
- Use `const` assertions for literal types and configuration objects
- Use functional programming patterns and avoid mutating state directly
- Use Result/Either patterns for error handling where appropriate

## Code Style & Organization
- Prefer `const` over `let`, avoid `var`
- Use PascalCase for classes and interfaces
- Use camelCase for variables and functions
- Use UPPER_SNAKE_CASE for constants
- Use uppercase for acronyms in CamelCase names: `URL`, `API`, `ID`
- Keep components and functions focused, limiting cyclomatic complexity
- Extract complex types into dedicated `types.ts` files or keep them alongside the implementation
- Do not use conversational filler, never use placeholders like `// ... rest of the code`

## Imports/Exports
- Use named exports over default exports
- Group imports strictly: built-in, external, internal, parent, sibling, index, then type
- Use absolute imports with path mapping when possible

## Error Handling
- Fail fast and throw descriptive errors early
- Prefer throwing typed errors over generic Error
- Use optional chaining (`?.`) and nullish coalescing (`??`)
- Avoid using `await` directly in return statements unless caught in a try/catch block
- Document complex logic and public APIs using JSDoc docstrings

## Security
- Never hardcode secrets, API keys, or passwords — use environment variables
- Validate all user inputs
- Use parameterized queries to prevent SQL injection
- Implement proper authentication and authorization
- Keep dependencies updated, use lock files
- Review third-party packages before adding, remove unused ones
- Encrypt sensitive data at rest and in transit
- Follow OWASP guidelines

## Testing
- Write unit tests for all public functions
- Use descriptive test names
- Mock external dependencies
- Aim for high test coverage (>80%)
- Run tests with minimal verbosity to avoid session timeouts
- Use grep/filter options to run specific tests when debugging
- Prefer `npm test -- --silent` or `yarn test --silent` for automated runs
