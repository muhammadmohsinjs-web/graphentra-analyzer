# @graphentra/visualizer

Local visualizer server and animated impact explorer for Graphentra analysis artifacts.

## Overview

The visualizer serves a browser interface to explore:
- Discovered TypeScript function nodes and CALLS edges.
- Recorded blast radius paths from deterministic evidence.
- What-if reverse dependency traversal.
- Diagnostics, limitations, and summary metadata.

It runs locally on loopback (`127.0.0.1`) with strict Host/Origin checking and CSP headers.

## Usage

```sh
# Start visualizer against a target repository containing .graphentra artifacts
npx @graphentra/visualizer [target-directory] [--port 4173]
```
