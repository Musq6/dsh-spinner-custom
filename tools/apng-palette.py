#!/usr/bin/env python3
"""Build a compact palette APNG from raw grayscale frames.

Why this exists
---------------
The running whale icon is drawn with a CSS mask, so the image contributes only
its alpha channel. A grayscale+alpha PNG therefore spends half its bytes on a
luma plane nobody reads. A palette PNG with per-entry alpha (`tRNS`) carries the
same information at 4 bits per pixel instead of 16, and DEFLATE likes it better
because most pixels share the single "fully transparent" index.

The palette is deliberately *grayscale* -- entry i is colour (v, v, v) and alpha
v for the same v. Masking by alpha and masking by luminance then produce the
identical result, so the asset cannot break if an engine picks the other mode.

Command line
------------
  build --raw F --w W --h H --frames N --fps F [--floor N] [--gain X]
        [--levels 4|16|256] [--out OUT.png]
  info  --png P
  dump  --png P --frame N [--out OUT.png]

`build` reads W*H bytes per frame, little-endian-free (raw is one byte per
pixel), applies `clip((v - floor) * gain)`, quantises to `levels` steps and
writes the APNG. `dump` re-decodes one frame so the result can be eyeballed.
"""

from __future__ import annotations

import argparse
import struct
import sys
import zlib

PNG_SIG = b"\x89PNG\r\n\x1a\n"

# PNG colour types
CT_GRAY = 0
CT_PALETTE = 3
CT_GRAY_ALPHA = 4

BIT_DEPTH_FOR_LEVELS = {4: 2, 16: 4, 256: 8}


def chunk(kind: bytes, payload: bytes) -> bytes:
    """One length/type/data/CRC chunk."""
    return (
        struct.pack(">I", len(payload))
        + kind
        + payload
        + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
    )


def ramp(levels: int) -> list[int]:
    """The alpha value each palette index stands for, spread over 0..255."""
    if levels == 256:
        return list(range(256))
    return [round(i * 255 / (levels - 1)) for i in range(levels)]


def pack_row(indices: bytes, width: int, bits: int) -> bytes:
    """Pack one row of palette indices most-significant-first, as PNG requires."""
    if bits == 8:
        return bytes(indices)
    out = bytearray()
    per_byte = 8 // bits
    mask = (1 << bits) - 1
    acc = 0
    used = 0
    for value in indices:
        acc = (acc << bits) | (value & mask)
        used += 1
        if used == per_byte:
            out.append(acc)
            acc = 0
            used = 0
    if used:
        out.append(acc << (bits * (per_byte - used)))
    return bytes(out)


def quantise_plane(
    frame: bytes, width: int, height: int, floor: int, gain: float, levels: int
) -> bytes:
    """Scale, clamp and quantise one raw gray plane into palette indices."""
    values = ramp(levels)
    # Nearest-index lookup, built once per plane so the inner loop is a table hit.
    lookup = bytearray(256)
    for raw in range(256):
        scaled = (raw - floor) * gain
        if scaled < 0:
            scaled = 0.0
        elif scaled > 255:
            scaled = 255.0
        best = 0
        best_delta = 1e9
        for index, value in enumerate(values):
            delta = abs(value - scaled)
            if delta < best_delta:
                best_delta = delta
                best = index
        lookup[raw] = best
    return bytes(lookup[b] for b in frame)


def encode_rows(indices: bytes, width: int, height: int, bits: int) -> bytes:
    """Filter each scanline (filter 0) and pack it, ready for DEFLATE."""
    stride = width
    row_bytes = (width * bits + 7) // 8
    out = bytearray()
    for y in range(height):
        row = indices[y * stride : (y + 1) * stride]
        packed = pack_row(row, width, bits)
        assert len(packed) == row_bytes, (len(packed), row_bytes)
        out.append(0)  # filter type None: indices are not numerically meaningful
        out += packed
    return bytes(out)


def deflate(data: bytes) -> bytes:
    return zlib.compress(data, 9)


def split_and_chunk(kind: bytes, payload: bytes, limit: int = 32768) -> list[bytes]:
    """Wrap payload in one or more chunks, splitting the way most writers do."""
    if not payload:
        return [chunk(kind, b"")]
    return [chunk(kind, payload[i : i + limit]) for i in range(0, len(payload), limit)]


def build(args: argparse.Namespace) -> int:
    levels = args.levels
    bits = BIT_DEPTH_FOR_LEVELS[levels]
    frame_len = args.w * args.h
    raw = open(args.raw, "rb").read()
    available = len(raw) // frame_len
    frames = args.frames if args.frames is not None else available
    if frames > available:
        raise SystemExit(f"raw holds {available} frames, need {frames}")

    counts: list[int] = []
    payloads: list[bytes] = []
    for i in range(frames):
        plane = raw[i * frame_len : (i + 1) * frame_len]
        indices = quantise_plane(plane, args.w, args.h, args.floor, args.gain, levels)
        filtered = encode_rows(indices, args.w, args.h, bits)
        counts.append(sum(1 for value in indices if value))
        payloads.append(deflate(filtered))

    delay_den = 1000
    delay_num = round(delay_den / args.fps)
    if delay_num < 1:
        raise SystemExit("fps too high for a 1000-tick delay denominator")

    values = ramp(levels)
    plte = bytes(component for value in values for component in (value, value, value))
    trns = bytes(values)

    out = bytearray(PNG_SIG)
    out += chunk(
        b"IHDR",
        struct.pack(">IIBBBBB", args.w, args.h, bits, CT_PALETTE, 0, 0, 0),
    )
    out += chunk(b"PLTE", plte)
    out += chunk(b"tRNS", trns)
    out += chunk(b"acTL", struct.pack(">II", frames, 0))

    sequence = 0

    def fctl(sequence: int) -> bytes:
        return chunk(
            b"fcTL",
            struct.pack(
                ">IIIIIHHBB",
                sequence,
                args.w,
                args.h,
                0,
                0,
                delay_num,
                delay_den,
                0,  # APNG_DISPOSE_OP_NONE
                0,  # APNG_BLEND_OP_SOURCE: every frame replaces its region
            ),
        )

    # The first frame is carried by IDAT; the rest ride in fdAT.
    out += fctl(sequence)
    sequence += 1
    out += b"".join(split_and_chunk(b"IDAT", payloads[0]))
    for payload in payloads[1:]:
        out += fctl(sequence)
        sequence += 1
        out += b"".join(
            split_and_chunk(
                b"fdAT", struct.pack(">I", sequence) + payload
            )
        )
        sequence += 1
    out += chunk(b"IEND", b"")

    with open(args.out, "wb") as handle:
        handle.write(out)

    total = len(out)
    body = sum(len(p) for p in payloads)
    print(
        f"{args.out}: {args.w}x{args.h} {bits}bpp palette, {frames} frames, "
        f"{delay_num}/{delay_den}s each ({args.fps:g} fps, "
        f"{frames * delay_num / delay_den:.2f}s loop)"
    )
    print(
        f"  file {total:,} B | deflated bodies {body:,} B | "
        f"{body / frames:,.0f} B/frame | avg lit pixels {sum(counts) / frames:,.0f}"
    )
    return 0


def read_chunks(blob: bytes):
    if not blob.startswith(PNG_SIG):
        raise SystemExit("not a PNG")
    position = len(PNG_SIG)
    while position + 8 <= len(blob):
        (length,) = struct.unpack(">I", blob[position : position + 4])
        kind = blob[position + 4 : position + 8]
        payload = blob[position + 8 : position + 8 + length]
        yield kind, payload
        position += 12 + length
        if kind == b"IEND":
            break


def info(args: argparse.Namespace) -> int:
    blob = open(args.png, "rb").read()
    frames = 0
    plays = None
    delay = None
    body = 0
    for kind, payload in read_chunks(blob):
        if kind == b"IHDR":
            w, h, bits, colour, comp, filt, interlace = struct.unpack(">IIBBBBB", payload)
            print(
                f"IHDR {w}x{h} bit_depth={bits} colour_type={colour} "
                f"interlace={interlace}"
            )
        elif kind == b"PLTE":
            print(f"PLTE {len(payload) // 3} entries")
        elif kind == b"tRNS":
            print(f"tRNS {len(payload)} entries, first={payload[0]} last={payload[-1]}")
        elif kind == b"acTL":
            total, plays = struct.unpack(">II", payload)
            frames = total
            print(f"acTL frames={total} plays={plays} (0 = loop forever)")
        elif kind == b"fcTL":
            (seq, fw, fh, fx, fy, num, den, dispose, blend) = struct.unpack(
                ">IIIIIHHBB", payload
            )
            delay = (num, den)
            print(
                f"fcTL seq={seq} {fw}x{fh}+{fx}+{fy} delay={num}/{den} "
                f"dispose={dispose} blend={blend}"
            )
        elif kind in (b"IDAT", b"fdAT"):
            body += len(payload)
    print(f"total {len(blob):,} B, frame bodies {body:,} B, avg {body / max(frames,1):,.0f} B/frame")
    if delay and plays is not None:
        print(f"loop length {frames * delay[0] / delay[1]:.2f}s")
    return 0


def dump(args: argparse.Namespace) -> int:
    """Re-decode one frame into a grayscale+alpha PNG for inspection."""
    blob = open(args.png, "rb").read()
    w = h = bits = 0
    alpha_table = bytes(range(256))
    # Every frame opens with an fcTL; the IDAT/fdAT chunks that follow carry it.
    frames: list[list[bytes]] = []
    for kind, payload in read_chunks(blob):
        if kind == b"IHDR":
            w, h, bits, colour, *_ = struct.unpack(">IIBBBBB", payload)
            if colour != CT_PALETTE or bits not in (2, 4, 8):
                raise SystemExit(f"unsupported colour_type={colour} bit_depth={bits}")
        elif kind == b"tRNS":
            alpha_table = payload
        elif kind == b"fcTL":
            frames.append([])
        elif kind == b"IDAT":
            frames[-1].append(payload)
        elif kind == b"fdAT":
            frames[-1].append(payload[4:])
    if not frames:
        raise SystemExit("no frames")
    if args.frame >= len(frames):
        raise SystemExit(f"only {len(frames)} frames")

    height = h
    row_bytes = (w * bits + 7) // 8
    raw = zlib.decompress(b"".join(frames[args.frame]))
    expected = height * (row_bytes + 1)
    if len(raw) != expected:
        raise SystemExit(f"scanline length {len(raw)} != {expected}")

    # Filter byte 0 everywhere by construction, so the rows need no unfiltering.
    gray_alpha = bytearray()
    for y in range(height):
        row = raw[y * (row_bytes + 1) + 1 : (y + 1) * (row_bytes + 1)]
        indices = unpack_row(row, w, bits)
        for index in indices:
            value = alpha_table[index]
            gray_alpha += bytes((value, value))
    body = bytearray()
    for y in range(height):
        body.append(0)
        body += gray_alpha[y * w * 2 : (y + 1) * w * 2]

    out = bytearray(PNG_SIG)
    out += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, CT_GRAY_ALPHA, 0, 0, 0))
    out += b"".join(split_and_chunk(b"IDAT", deflate(bytes(body))))
    out += chunk(b"IEND", b"")
    with open(args.out, "wb") as handle:
        handle.write(out)
    print(f"{args.out}: frame {args.frame} of {len(frames)} -> {w}x{h} gray+alpha")
    return 0


def unpack_row(row: bytes, width: int, bits: int) -> list[int]:
    if bits == 8:
        return list(row[:width])
    per_byte = 8 // bits
    mask = (1 << bits) - 1
    out: list[int] = []
    for byte in row:
        for slot in range(per_byte - 1, -1, -1):
            out.append((byte >> (bits * slot)) & mask)
    return out[:width]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    b = sub.add_parser("build", help="assemble a palette APNG from raw gray frames")
    b.add_argument("--raw", required=True)
    b.add_argument("--w", type=int, required=True)
    b.add_argument("--h", type=int, required=True)
    b.add_argument("--frames", type=int, default=None)
    b.add_argument("--fps", type=float, required=True)
    b.add_argument("--floor", type=int, default=0)
    b.add_argument("--gain", type=float, default=1.0)
    b.add_argument("--levels", type=int, default=16, choices=[4, 16, 256])
    b.add_argument("--out", required=True)
    b.set_defaults(func=build)

    i = sub.add_parser("info", help="summarise an APNG")
    i.add_argument("--png", required=True)
    i.set_defaults(func=info)

    d = sub.add_parser("dump", help="extract one frame as gray+alpha PNG")
    d.add_argument("--png", required=True)
    d.add_argument("--frame", type=int, default=0)
    d.add_argument("--out", required=True)
    d.set_defaults(func=dump)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
