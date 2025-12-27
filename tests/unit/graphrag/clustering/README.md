# Clustering Module Test Suite

Comprehensive unit tests for the `src/graphrag/clustering/` module.

## Test Files

### boost-calculator.test.ts

Tests for the cluster boost calculator module (`src/graphrag/clustering/boost-calculator.ts`).

**Coverage:**

- 23 test cases
- 100% function coverage
- All edge cases covered

**Test Categories:**

1. **Basic Functionality (4 tests)**
   - Basic cluster boost computation with multiple capabilities
   - Insufficient capabilities (< 2) returns empty boosts
   - Insufficient context tools (< 2) returns empty boosts
   - No active cluster identified returns empty boosts

2. **Cache Hit/Miss Scenarios (2 tests)**
   - Cache hit skips expensive O(n³) computation
   - Cache miss triggers full computation pipeline

3. **Initialization Tests (5 tests)**
   - Initializes SpectralClusteringManager when null
   - Syncs to LocalAlphaCalculator on first initialization
   - Syncs to LocalAlphaCalculator after cache miss
   - Does not sync to LocalAlphaCalculator on cache hit
   - Handles null LocalAlphaCalculator gracefully

4. **PageRank Integration (3 tests)**
   - Applies PageRank boost with default weight (0.3)
   - Skips zero PageRank scores
   - Combines cluster and PageRank boosts correctly

5. **Edge Cases and Error Handling (6 tests)**
   - Handles empty capabilities list
   - Handles empty context tools
   - Handles capabilities without toolsUsed field
   - Handles errors gracefully without throwing
   - Handles null LocalAlphaCalculator
   - Realistic multi-capability scenario

6. **getCapabilityPageranks Function (3 tests)**
   - Returns all PageRank scores from clustering manager
   - Returns empty map for null clustering
   - Returns empty map when no PageRanks computed

**Mock Objects:**

- `MockSpectralClusteringManager`: Mocks spectral clustering operations
- `MockLocalAlphaCalculator`: Mocks local alpha calculator

**Key Test Patterns:**

- Uses Deno test framework with describe/it style
- Comprehensive mock setup with configurable behavior
- Tests both success and failure scenarios
- Validates both cluster boost and PageRank boost calculations
- Tests cache behavior (hit vs miss)
- Tests synchronization with LocalAlphaCalculator (ADR-048)

## Running Tests

```bash
# Run all clustering tests
deno test tests/unit/graphrag/clustering/ --allow-read --allow-write --allow-env

# Run specific test file
deno test tests/unit/graphrag/clustering/boost-calculator.test.ts --allow-read --allow-write --allow-env

# Run with coverage
deno test --coverage=coverage tests/unit/graphrag/clustering/
deno coverage coverage
```

## Test Quality Metrics

- **Test Count**: 23 tests
- **Success Rate**: 100%
- **Execution Time**: ~16ms
- **Coverage**: All exported functions and edge cases

## Module Dependencies

Tests mock the following dependencies:

- `SpectralClusteringManager` from `src/graphrag/spectral-clustering.ts`
- `LocalAlphaCalculator` from `src/graphrag/local-alpha.ts`
- `DagScoringConfig` from `src/graphrag/dag-scoring-config.ts`
- `Capability` type from `src/capabilities/types.ts`

## Future Test Additions

Potential areas for additional testing:

- Performance benchmarks for large capability sets (>1000 capabilities)
- Integration tests with real SpectralClusteringManager
- Thread safety and concurrency testing
- Memory leak detection for long-running scenarios
