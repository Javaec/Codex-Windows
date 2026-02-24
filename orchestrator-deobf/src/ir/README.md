# IR Directory

This directory contains semantic-ir v2 and ownership models shared by deobfuscation and emit stages.

Current source of truth:

- `semantic-ir.ts`: semantic-ir v2 with domain declarations (`service/use-case/store/hook/transport/ui`) and declaration clusters.
- `ownership-model.ts`: hard ownership resolver (`one symbol = one layer`) built from semantic-ir declarations.
