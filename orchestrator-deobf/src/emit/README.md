# Emit Directory

This directory hosts template-driven emitters that synthesize final TypeScript modules from semantic-ir v2.

Key behavior:

- Module plans are cluster-driven (`call-graph + state + route/event flow`) instead of random symbol slicing.
- Archetype contracts are strict (`hook/service/ui/transport/store`) and emitted as runtime module contracts.
- Statement budget is enforced per module plan.
