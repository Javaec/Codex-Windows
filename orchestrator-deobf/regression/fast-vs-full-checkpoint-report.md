# Fast vs Full Checkpoint Report

Generated: 2026-03-01T13:29:17.056Z
Source: C:\Codex-Windows\orchestrator-deobf\regression\cycle-report.json

## Cycle Summary

- Completed cycles: 4
- Stop reason: kpi_failed:c04
- fullCheckpointEvery: 4
- fast cycles: 3
- full cycles: 1

## Aggregate Comparison

| Metric | Fast (avg) | Full (avg) | Delta (Full-Fast) |
|---|---:|---:|---:|
| averageScore | 0.9638 | 0.962 | -0.0018 |
| nameQualityAverage | 0.7987 | 0.7888 | -0.0099 |
| highConfidenceSymbolsAverage | 738 | 722 | -16 |
| worstFileDecileScoreAverage | 0.7711 | 0.7644 | -0.0067 |
| promotionBudgetUsed | 153.3333 | 220 | 66.6667 |
| promotionUpdatedCount | 145.6667 | 209 | 63.3333 |
| hotFocusFileAverage | 14 | 12.75 | -1.25 |

## Latest Fast vs Latest Full

| Metric | Latest Fast | Latest Full | Delta |
|---|---:|---:|---:|
| averageScore | 0.9638 | 0.962 | -0.0018 |
| nameQualityAverage | 0.7987 | 0.7888 | -0.0099 |
| highConfidenceSymbolsAverage | 738 | 722 | -16 |
| mappedSymbolsAverage | 1425 | 1425 | 0 |
| worstFileDecileScoreAverage | 0.7711 | 0.7644 | -0.0067 |
| promotionBudgetUsed | 180 | 220 | 40 |
| promotionUpdatedCount | 171 | 209 | 38 |

## Notes

- Latest full checkpoint KPI failed: nameQualityAverage regressed: 0.7888 < 0.7987
- Fast cycles show higher name-quality due to narrower profile pressure; full checkpoint adds stricter profile diversity and can expose lower-confidence naming decisions.
- Promotion auto-boost worked (budget increased on stagnation) and raised update count in later fast cycles.
