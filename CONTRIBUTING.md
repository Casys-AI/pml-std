# Contributing to Casys PML

Thank you for your interest in contributing to Casys PML! This document provides guidelines and
instructions for contributing.

## Getting Started

### Prerequisites

- [Deno](https://deno.land/) v2.0+
- Node.js 18+ (for some MCP servers)
- Git

### Local Setup

```bash
# Clone the repository
git clone https://github.com/Casys-AI/casys-pml.git
cd casys-pml

# Copy environment template
cp .env.example .env

# Install dependencies
deno task install

# Run tests
deno task test

# Start development server
deno task dev
```

## Development Workflow

### Branch Naming

- `feature/` - New features (e.g., `feature/dag-visualization`)
- `fix/` - Bug fixes (e.g., `fix/search-ranking`)
- `docs/` - Documentation updates
- `refactor/` - Code refactoring

### Commit Messages

We follow conventional commits:

```
type(scope): description

feat(search): add semantic tool search
fix(dag): resolve parallel execution bug
docs(readme): update installation instructions
refactor(gateway): simplify request handling
```

### Code Style

- Run `deno fmt` before committing
- Run `deno lint` to check for issues
- Run `deno task check` for type checking

## Pull Request Process

1. **Fork** the repository
2. **Create** a feature branch from `main`
3. **Make** your changes with clear commits
4. **Test** your changes locally
5. **Push** to your fork
6. **Open** a Pull Request with:
   - Clear description of changes
   - Link to related issues (if any)
   - Screenshots for UI changes

### PR Checklist

- [ ] Tests pass (`deno task test`)
- [ ] Code is formatted (`deno fmt`)
- [ ] No lint errors (`deno lint`)
- [ ] Types check (`deno task check`)
- [ ] Documentation updated (if needed)

## Project Structure

```
src/
├── cli/          # CLI commands
├── mcp/          # MCP gateway server
├── graphrag/     # Graph-based tool recommendations
├── capabilities/ # Tool discovery & search
├── dag/          # Workflow execution engine
├── sandbox/      # Secure code execution
└── web/          # Fresh dashboard
```

## Testing

```bash
# Run all tests
deno task test

# Run specific test file
deno test src/graphrag/graph.test.ts

# Run with coverage
deno task test:coverage
```

## Reporting Issues

- Use [GitHub Issues](https://github.com/Casys-AI/casys-pml/issues)
- Include reproduction steps
- Provide environment details (OS, Deno version)
- Add relevant logs or screenshots

## Questions?

- Open a [Discussion](https://github.com/Casys-AI/casys-pml/discussions)
- Check existing issues and discussions first

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
