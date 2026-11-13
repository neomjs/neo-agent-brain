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
- **The unit is the container.** A cumulative counter belongs to one container's lifetime, so every
  series is one container's. A service with replicas has one entry per replica, each naming its
  service; nothing is summed or differenced across replicas.
- **Resident heap** is `memory.stat`'s `anon`. File-backed bytes are kept beside it in
  `samples.jsonl` and are never added to it.
- **CPU** is cores: the growth of `usage_usec` between two ticks over the time between them.
- **Volumes** are the ones that carry the project's compose label, sized from `docker system df -v`
  by their exact names, at both ends of the window. A name that merely starts with the project's
  name is no membership.
- **Coverage** travels with every report: ticks against expected ticks (a tick at the window's
  start and one per full interval inside it), gaps per container (a failed read adds no sample and
  is never interpolated), resets per container (an interval in which any counter went backwards,
  usually a restart; it is dropped whole), the number of intervals each figure rests on, and
  whether a stop signal cut the window short.
- **Unknown is not zero.** An I/O or network part that failed or is malformed is `null`; an empty
  one is a measured 0. A figure without a usable interval is `null`.

What it leaves out, declared:

- On a host that runs its containers in a VM, the VM's own cost: the guest kernel, its page cache
  and its free memory belong to the host's bill and to no container.
- Page cache, as above.
- Everything outside the compose project: seats, bridges and the model server. The serving-cost
  meter samples the model server.

A window of ten minutes at 30 seconds holds 19 intervals, so its p95 is its maximum. A p95 that
says more than the maximum needs a longer window.

## Run protocol

```bash
node ai/scripts/benchmark/plane-sampler.mjs --project <compose project> --hardware <slug> \
    --window 10m --interval 30s --out <dir>
```

It writes `samples.jsonl` (every tick) and `report.json` into `--out` and nothing anywhere else.
One run per directory: an existing `samples.jsonl` is refused. The run ends with its window, also
when the interval is longer; a stop signal ends it at once and still writes the report, marked
`stoppedEarly`.

## Run ledger

| Run | Hardware (named) | Window | Coverage |
|---|---|---|---|
| Reference run, 2026-11-13 05:52:32Z | `apple-m5-max-colima-vz` | 10m at 30s | 20 of 20 ticks; per container 20 samples, 19 intervals, 0 gaps, 0 resets; not stopped early |

Re-run: `--project neo-local-agent-os --hardware apple-m5-max-colima-vz --window 10m --interval 30s`.

## Results: reference run

The plane was in normal operation; no load was induced. Each service ran one container. Heap is in
GiB, CPU in cores.

| Service | Heap p50 | Heap max | Cores p50 | Cores max |
|---|---|---|---|---|
| chroma | 12.783 | 12.783 | 0.002 | 0.161 |
| mc-server | 1.891 | 1.944 | 0.279 | 0.489 |
| orchestrator | 0.482 | 0.898 | 0.122 | 0.295 |
| kb-server | 0.283 | 0.284 | 0.008 | 0.022 |
| fleet-server | 0.050 | 0.050 | 0.012 | 0.014 |
| ingress | 0.020 | 0.020 | 0.002 | 0.003 |

The project owns 14 volumes, which held 26.61 GB at the window's end. Two more volumes carry the
project's name as a prefix and not its label; they are not counted.

The window shows what one line cannot: the orchestrator's heap moved between 0.48 and 0.90 GiB
inside ten minutes, and the vector store idles at the median and takes a sixth of a core at its
peak.

### Beside `docker stats`, the same second

One `docker stats --no-stream` read at 05:52:31Z, against the run's first tick at 05:52:32Z:

| Service | `docker stats` | Sampler: anonymous | Sampler: file-backed |
|---|---|---|---|
| chroma | 12.84 GiB | 12.783 GiB | 1.759 GiB |
| mc-server | 1.937 GiB | 1.896 GiB | 0.187 GiB |
| orchestrator | 606.6 MiB | 0.517 GiB | 5.628 GiB |
| kb-server | 298.1 MiB | 0.282 GiB | 0.010 GiB |
| fleet-server | 54.31 MiB | 0.050 GiB | 0.000 GiB |
| ingress | 22.03 MiB | 0.020 GiB | 0.001 GiB |

For every service the line lies above the anonymous memory, here by 2 MiB to 77 MiB. The
orchestrator also had 5.6 GiB of file-backed pages at that moment: memory the kernel gives back
under pressure, and no part of what the service needs.

## Provenance discipline

Every number that lands here carries the hardware slug, the window and interval, the coverage
counts and the reproducing command. A figure missing any of these is refused at review.
