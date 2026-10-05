"""Evidence fingerprint: the observable traits of a recorder's storage layout, as a set of named tokens.

Two images of the same recorder model share most tokens; two different models do not. Similarity is
Jaccard over these tokens (see backend/src/knowledge.ts) rather than a learned embedding, so a match
can always be explained as "these tokens agreed and these differed" — which an opaque vector cannot do.

Nothing here guesses a vendor. It only records what was observed.
"""

CHANNEL_BUCKETS = (1, 2, 4, 8, 16, 32, 64)


def _bucket(n):
    """Channel counts vary with how many cameras were plugged in, so compare the model's capacity instead."""
    return next((b for b in CHANNEL_BUCKETS if n <= b), ">64")


def _fs_tokens(filesystems):
    for fs in filesystems:
        kind = (fs.get("type") or fs.get("filesystem") or "unknown").lower()
        yield f"fs:{kind}"
        if fs.get("block_size"):
            yield f"fs-block:{fs['block_size']}"


def build(identification, bundle, reader, induction=None):
    """Tokens + readable features for one evidence image. `induction` is an earlier M3.2 result, if any."""
    tokens, features = set(), {}

    adapter = identification.get("adapter")
    tokens.add(f"adapter:{adapter or 'none'}")
    features["adapter"] = adapter

    for family in (identification.get("family") or "").split(", "):
        if family and family != "Unknown":
            tokens.add(f"family:{family}")
    features["family"] = identification.get("family")

    if container := identification.get("container"):
        tokens.add(f"container:{container}")
    features["container"] = container

    signatures = [s.get("signature") for s in identification.get("signatures", []) if s.get("signature")]
    tokens.update(f"sig:{s}" for s in signatures)
    features["signatures"] = signatures

    filesystems = identification.get("filesystems") or []
    tokens.update(_fs_tokens(filesystems))
    features["filesystems"] = [fs.get("type") or fs.get("filesystem") for fs in filesystems]

    # First sector: on a proprietary disk this is the superblock magic, and it is the single most
    # identifying trait. On a filesystem disk it is a boot sector that varies, so only the magic is kept.
    head = reader.read(0, 16)
    features["lba0_hex"] = head.hex(" ")
    if any(head[:8]):
        tokens.add(f"lba0:{head[:8].hex()}")

    vendor = bundle.get("vendor") or {}
    if vendor.get("name"):
        tokens.add(f"brand:{vendor['name']}")
    features["vendor_observed"] = vendor.get("name")
    features["vendor_evidence"] = vendor.get("evidence", [])

    kinds = sorted({run["kind"] for run in (bundle.get("carve") or {}).get("runs", [])})
    tokens.update(f"carve:{k}" for k in kinds)
    features["carved_kinds"] = kinds

    if probe := identification.get("probe"):
        if probe.get("format"):
            tokens.add(f"probe:{probe['format']}")
        features["probe_format"] = probe.get("format")

    for codec in sorted({r.get("codec") for r in bundle.get("recordings", []) if r.get("codec")}):
        tokens.add(f"codec:{codec}")

    channels = {r["channel"] for r in bundle.get("recordings", []) if r.get("channel") is not None}
    if channels:
        tokens.add(f"channels:{_bucket(max(channels))}")
        features["channels_seen"] = sorted(channels)

    # A learned record header is the strongest trait of an otherwise unknown recorder: same roles at the
    # same offsets means the same layout. Only a verified schema is used.
    if induction and induction.get("found") and (induction.get("verification") or {}).get("accepted"):
        schema = induction["schema"]
        roles = [f"hdr:{f['role']}@{f['offset']}:{f['width']}" for f in schema.get("fields", [])]
        tokens.update(roles)
        tokens.add(f"hdr-size:{schema.get('fixed_header_bytes')}")
        features["learned_header"] = {"fields": roles, "anchor": schema.get("anchor"),
                                      "fixed_header_bytes": schema.get("fixed_header_bytes")}

    return {"tokens": sorted(tokens), "features": features,
            "kind": "device" if adapter not in (None, "media", "filesystem") else "unknown",
            "recordings": len(bundle.get("recordings", []))}
