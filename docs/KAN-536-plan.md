# Plan for KAN-536

## Changes

### 1. `background.js` - Fix footer offset for early exits
**Path:** `background.js:482`
Change `m.total` to `landed + m.vh` when calculating `drawFooterTop`. If the capture loop breaks early because the scroller refuses to advance, `m.total` is larger than the actual captured content, leaving a gap before the footer. `landed + m.vh` ensures the footer is drawn precisely below the last captured slice, which matches the `filled` height calculation used to trim the final canvas.

```javascript
      const drawFooterTop = Math.round((Math.max(0, m.rect.top) + landed + m.vh) * m.dpr * scale);
```

## Verification Steps
1. **Change `drawFooterTop` calculation** → verify: Replace `m.total` with `landed + m.vh`.
2. **Run test suite** → verify: All existing tests pass.

## Open Questions
None.
