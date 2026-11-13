# Plane sampler — what the plane's containers hold, over a window

> **Status: INSTRUMENT LANDED · ONE REFERENCE RUN.** Every figure below names its run. A figure
> without a named run is not published here.

## Why

One `docker stats` line is the usual answer to "how much does the plane need". It answers for one
instant, and it counts page cache a container is using as memory the container holds. A host sized
from that line gets the wrong number for the service that reads large files, and learns nothing
about CPU bursts, a restart inside the hour, or a read that failed.

The sampler asks the same question over a window, reads the answer from each container's own
cgroup, and writes down how much of the window it saw.

## Method

- **Instrument:** `ai/scripts/benchmark/plane-sampler.mjs`. Per tick, one `docker exec` per
  container of a compose project reads that container's cgroup v2 files (`memory.stat`, `cpu.stat`,
  `io.stat`) and the byte counters of its network interfaces. Its rules are unit-pinned in
  `ai/scripts/benchmark/helpers/planeSamplerCore.mjs`.
- **Resident heap** is `memory.stat`'s `anon`. File-backed bytes are kept beside it in
  `samples.jsonl` and are never added to it.
- **CPU** is cores: the growth of `usage_usec` between two ticks over the time between them.
- **Volumes** are the project's volume sizes from `docker system df -v`, at both ends of the window.
- **Coverage** travels with every report: ticks against expected ticks, gaps per service (a failed
  read adds no sample and is never interpolated), restarts per service (a counter that went
  backwards; its delta is dropped), and whether a stop signal cut the window short.

What it leaves out, declared:

- On a host that runs its containers in a VM, the VM's own cost: the guest kernel, its page cache
  and its free memory belong to the host's bill and to no container.
- Page cache, as above.
- Everything outside the compose project: seats, bridges and the model server. The serving-cost
  meter samples the model server.

A window of ten minutes at 30 seconds holds 19 deltas, so its p95 is its maximum. A p95 that says
more than the maximum needs a longer window.

## Run protocol

```bash
node ai/scripts/benchmark/plane-sampler.mjs --project <compose project> --hardware <slug> \
    --window 10m --interval 30s --out <dir>
```

It writes `samples.jsonl` (every tick) and `report.json` into `--out` and nothing anywhere else.
One run per directory: an existing `samples.jsonl` is refused. A stop signal inside the window
still writes the report, marked `stoppedEarly`.

## Run ledger

| Run | Hardware (named) | Window | Coverage |
|---|---|---|---|
| Reference run, 2026-11-13 05:01:55Z | `apple-m5-max-colima-vz` | 10m at 30s | 20 of 20 ticks, 0 gaps, 0 restarts, not stopped early |

Re-run: `--project neo-local-agent-os --hardware apple-m5-max-colima-vz --window 10m --interval 30s`.

## Results: reference run

The plane was in normal operation; no load was induced. Heap is in GiB, CPU in cores.

| Service | Heap p50 | Heap max | Cores p50 | Cores max |
|---|---|---|---|---|
| chroma | 12.800 | 12.801 | 0.002 | 0.240 |
| orchestrator | 1.750 | 2.143 | 0.130 | 0.393 |
| mc-server | 1.745 | 1.887 | 0.335 | 0.577 |
| kb-server | 0.264 | 0.266 | 0.008 | 0.012 |
| fleet-server | 0.050 | 0.066 | 0.012 | 0.014 |
| ingress | 0.018 | 0.020 | 0.002 | 0.003 |

The project's 16 volumes held 26.61 GB at the window's end.

The window shows what one line cannot: the orchestrator's heap moved between 1.75 and 2.14 GiB
inside ten minutes, and the vector store idles at the median and takes a quarter of a core at its
peak.

### Beside `docker stats`, the same second

One `docker stats --no-stream` read at 05:01:54Z, against the run's first tick at 05:01:55Z:

| Service | `docker stats` | Sampler: anonymous | Sampler: file-backed |
|---|---|---|---|
| chroma | 12.86 GiB | 12.800 GiB | 1.750 GiB |
| orchestrator | 1.845 GiB | 1.750 GiB | 5.628 GiB |
| mc-server | 1.709 GiB | 1.669 GiB | 0.176 GiB |
| kb-server | 276.7 MiB | 0.261 GiB | 0.008 GiB |
| fleet-server | 54.14 MiB | 0.050 GiB | 0.000 GiB |
| ingress | 20.23 MiB | 0.018 GiB | 0.001 GiB |

For every service the line lies above the anonymous memory, here by 2 MiB to 95 MiB. The
orchestrator also had 5.6 GiB of file-backed pages at that moment: memory the kernel gives back
under pressure, and no part of what the service needs.

## Provenance discipline

Every number that lands here carries the hardware slug, the window and interval, the coverage
counts and the reproducing command. A figure missing any of these is refused at review.
