# IR Directory

This directory contains semantic-ir v4 and ownership models shared by deobfuscation and emit stages.

Current source of truth:

- `semantic-ir.ts`: semantic-ir v4 with explicit entities (`service/usecase/store/hook/transport/ui`), declaration fingerprints, symbol-role graph, and evidence ledger with conflict resolution.
- `obfuscation-profile.ts`: profile adapters (`profile-v1`, `profile-v2`) for snapshot obfuscation variants.
- `ownership-model.ts`: hard ownership resolver (`one symbol = one layer`) built from semantic-ir declarations.
