# FastMCP vs SDK Comparison

## Code Size Comparison

| Aspect | SDK (gateway-server.ts) | FastMCP (server.ts) |
|--------|-------------------------|---------------------|
| Lines of code | ~1200 | ~220 |
| Tool definitions | ~50 lines per tool | ~20 lines per tool |
| Boilerplate | High (Server setup, handler registration) | Low (declarative) |
| Schema definition | Manual JSON Schema | Zod with auto-inference |

## Developer Experience

### FastMCP Advantages

1. **Declarative Tool Definition**
   ```typescript
   // FastMCP
   server.addTool({
     name: "pml_discover",
     description: "...",
     parameters: z.object({ intent: z.string() }),
     execute: async (args) => JSON.stringify(result),
   });
   ```

2. **Built-in Transport Switching**
   ```typescript
   // stdio or HTTP with one line
   server.start({ transportType: "httpStream" });
   ```

3. **Automatic Schema Generation** from Zod

4. **Built-in Features**: Sessions, Auth, CORS, Health checks

### SDK Advantages

1. **Full Control**: Direct access to all MCP protocol details
2. **Custom Error Handling**: Fine-grained error codes and formats
3. **Integration**: Easier to integrate with complex systems (SHGAT, DR-DSP, etc.)
4. **Performance**: Potential for better optimization in hot paths

## Migration Path

For our architecture refactoring:

1. **Keep SDK for gateway-server.ts**: Too much SHGAT/DR-DSP integration
2. **Use FastMCP for standalone MCP servers**: Like capability-server.ts
3. **Test FastMCP for new MCP features**: Lower dev effort

## Recommendation

**Hybrid approach**:
- Main gateway: Keep SDK (complex integration needs)
- Simple tools/servers: Use FastMCP (faster development)
- New features: Start with FastMCP prototype, migrate if needed

## Test Results

Run with:
```bash
deno run --allow-all src/mcp/fastmcp-prototype/server.ts --http --port=3004
```

Then test with:
```bash
curl -X POST http://localhost:3004/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```
