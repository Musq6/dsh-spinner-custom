#!/usr/bin/env python3
"""Draw spinner artwork as raw grayscale frames.

Why this ships with the repository
----------------------------------
The plugin needs *some* artwork to be usable out of the box, but artwork is
exactly the part that carries a licence. So the shipped default is generated
from this file: a pure function of the numbers on its command line, with no
third party's pixels anywhere in it, and anybody can re-derive it byte for byte
and check that claim.

Frames are written as one byte per pixel -- the same format apng-palette.py
reads and ffmpeg writes with `-pix_fmt gray` -- so this plugs into the existing
pipeline with nothing new in the middle. Brightness becomes alpha downstream
(see tools/apng-palette.py for why), so this file thinks only in "how opaque".

Several shapes
--------------
`--shape` picks which one. They are not presets of each other: each is its own
idea, drawn by its own function, and the only things they share are the canvas
conventions below. Adding one means adding a class, not editing the others.

Every shape is built the same way: `__init__` computes whatever depends only on
the canvas, `paint` evaluates one frame from the loop phase. That split is what
keeps this fast enough to be worth running -- the per-pixel constants are
computed once for the whole animation rather than once per frame.

Two rules every shape has to keep, both of them about the *loop* rather than
about the picture:

  * phase 0 and phase 1 must be the same pose. The APNG runs forever, so a
    shape that does not close on itself blinks once per cycle -- a defect that
    is very hard to unsee once you notice it. Every time-varying quantity here
    is periodic in `phase` with integer period 1, or is a rotation by a
    symmetry angle of the shape.
  * the outline must stay inside the canvas with margin. The icon box stretches
    the bitmap to fill (`center / 100% 100%`), so anything touching an edge
    gets flattened against it and stops reading as a shape.

  python tools/make-placeholder.py --out frames.raw --w 160 --h 160 --frames 60
  python tools/make-placeholder.py --shape cross --out frames.raw --w 160 --h 160 --frames 60

Nothing here is antialiased by hand: edges use a raised-cosine ramp about two
pixels wide, which is what keeps them from stair-stepping once the artwork is
scaled down to the delivered icon size.
"""

from __future__ import annotations

import argparse
import math
import sys

TAU = 2.0 * math.pi

# Fractions of the canvas. Shared so every shape carries the same visual weight
# as the one next to it: a ring of radius 0.40*span and a cross with arms of the
# same length look like siblings, which is the point of having several.
RADIUS = 0.40
SOFTNESS = 0.012


def edge(t: float) -> float:
    """A soft step: 1 at `t` <= 0, 0 at `t` >= 1, raised cosine in between."""
    if t <= 0.0:
        return 1.0
    if t >= 1.0:
        return 0.0
    return 0.5 + 0.5 * math.cos(math.pi * t)


def put(frames: bytearray, index: int, value: float) -> None:
    """Write one pixel, keeping the brighter contribution.

    Shapes that draw overlapping pieces (arms of a cross, individual dots) rely
    on this to union them without either one erasing the other.
    """
    if value <= 0.0:
        return
    byte = 255 if value >= 1.0 else int(value * 255.0 + 0.5)
    if byte > frames[index]:
        frames[index] = byte


def centred(w: int, h: int):
    """The canvas conventions, so no shape has to restate them.

    The centre sits between pixels when the edge length is even, which is why
    this is (n - 1) / 2 rather than n / 2: the artwork has to be symmetric about
    the same point the mask is, or a shape that should be still will crawl.
    """
    return (w - 1) / 2.0, (h - 1) / 2.0, min(w, h)


class Shape:
    """Base for the shapes. Subclasses fill in `name` and `paint`."""

    name = ""
    #: Set when the shape needs `--duty` / `--decay`, so the help can say so.
    uses_trail = False

    def __init__(self, w: int, h: int, args: argparse.Namespace) -> None:
        self.w = w
        self.h = h
        self.pixels = w * h
        self.cx, self.cy, span = centred(w, h)
        self.radius = span * RADIUS
        self.soft = max(1.0, span * SOFTNESS)

    def paint(self, phase: float, frames: bytearray, base: int) -> None:
        raise NotImplementedError


class CometRing(Shape):
    """The bundled default: a rotating band with a fading trail, plus a
    breathing centre dot."""

    name = "comet-ring"
    uses_trail = True

    def __init__(self, w, h, args):
        super().__init__(w, h, args)
        self.duty = args.duty
        r_outer = self.radius
        r_inner = r_outer * 0.70
        r_dot = min(w, h) * 0.055

        band = [0.0] * self.pixels
        dot = [0.0] * self.pixels
        ang = [0.0] * self.pixels

        i = 0
        for y in range(h):
            dy = y - self.cy
            for x in range(w):
                dx = x - self.cx
                r = math.hypot(dx, dy)
                band[i] = edge((r - r_outer) / self.soft) * edge((r_inner - r) / self.soft)
                dot[i] = edge((r - r_dot) / self.soft)
                ang[i] = (math.atan2(dy, dx) % TAU) / TAU
                i += 1

        self.band = band
        self.dot = dot
        self.ang = ang

        # The trail curve is the only expensive function called per pixel per
        # frame, so it becomes a table. 1024 steps is finer than the 16 alpha
        # levels the encoder will quantise to anyway.
        self.steps = 1024
        self.trail = [(1.0 - k / self.steps) ** args.decay for k in range(self.steps + 1)]

    def paint(self, phase, frames, base):
        pulse = 0.55 + 0.45 * (0.5 - 0.5 * math.cos(TAU * phase))
        duty = self.duty
        floor = 1.0 - duty
        steps = self.steps
        trail = self.trail
        band = self.band
        dot = self.dot
        ang = self.ang
        for i in range(self.pixels):
            u = ang[i] - phase
            u -= math.floor(u)  # wrap into 0..1 without a branch
            value = band[i] * (duty + floor * trail[int(u * steps)])
            dot_value = dot[i] * pulse
            if dot_value > value:
                value = dot_value
            put(frames, base + i, value)


class Rounding(Shape):
    """A square whose corners round off until it is a circle, then back.

    One superellipse `|x/a|^n + |y/a|^n = 1` with `n` swept from 2 (a circle) to
    10 (square with tight corners). The soft edge is placed by first-order
    distance -- `(F - 1) / |grad F|` -- rather than by the radial difference,
    because on a square those two differ by up to a factor of the square root of
    two at the corners, and the edge would visibly thicken there.
    """

    name = "rounding"
    EXPONENT = 10.0

    def __init__(self, w, h, args):
        super().__init__(w, h, args)
        dx = [0.0] * self.pixels
        dy = [0.0] * self.pixels
        i = 0
        for y in range(h):
            for x in range(w):
                dx[i] = x - self.cx
                dy[i] = y - self.cy
                i += 1
        self.dx = dx
        self.dy = dy

    def paint(self, phase, frames, base):
        p = 0.5 - 0.5 * math.cos(TAU * phase)
        n = 2.0 + (self.EXPONENT - 2.0) * p
        # A quarter turn per loop: a symmetry of both the circle and the square,
        # so the corners sweep without the loop ever landing off-pose.
        theta = (TAU / 4.0) * phase
        c = math.cos(theta)
        s = math.sin(theta)
        R = self.radius
        soft = self.soft
        nm1 = n - 1.0
        dxs = self.dx
        dys = self.dy
        for i in range(self.pixels):
            dx = dxs[i]
            dy = dys[i]
            u = abs(dx * c + dy * s) / R
            v = abs(-dx * s + dy * c) / R
            up = u ** nm1
            vp = v ** nm1
            gradient = n * math.hypot(up, vp) / R
            if gradient < 1e-12:
                put(frames, base + i, 1.0)  # the exact centre: inside, no normal
                continue
            put(frames, base + i, edge(((u * up + v * vp - 1.0) / gradient) / soft))


class Cutout(Shape):
    """A disc with a hole opening in its middle and closing again.

    The clearest way to show a solid becoming a ring: nothing is added, only
    removed, so the eye reads it as one object changing rather than two shapes
    swapping.
    """

    name = "cutout"

    def __init__(self, w, h, args):
        super().__init__(w, h, args)
        r = [0.0] * self.pixels
        i = 0
        for y in range(h):
            dy = y - self.cy
            for x in range(w):
                r[i] = math.hypot(x - self.cx, dy)
                i += 1
        self.r = r

    def paint(self, phase, frames, base):
        p = 0.5 - 0.5 * math.cos(TAU * phase)
        inner = self.radius * 0.80 * p
        R = self.radius
        soft = self.soft
        r = self.r
        for i in range(self.pixels):
            put(frames, base + i, edge((r[i] - R) / soft) * edge((inner - r[i]) / soft))


class Fold(Shape):
    """An equilateral triangle that folds through its own centre and reopens
    inverted.

    For an equilateral triangle a point reflection is the same as a rotation by
    60 degrees, because the triangle only has three-fold symmetry. So there is
    no separate "inverted" pose to draw: spinning the triangle a third of a turn
    per loop passes through 60 degrees -- the point reflection, i.e. upside down
    -- at exactly the halfway point. Put the size on a cosine so it is at its
    largest at both ends of the loop and zero in between, and one cycle reads as
    grow, collapse, come back inverted, collapse, return.

    The two do not need synchronising beyond that: the size is zero at both
    quarter points, so the pose can only ever change while the shape has no
    extent to change.
    """

    name = "fold"

    def __init__(self, w, h, args):
        super().__init__(w, h, args)
        phi = [0.0] * self.pixels
        r = [0.0] * self.pixels
        i = 0
        for y in range(h):
            dy = y - self.cy
            for x in range(w):
                dx = x - self.cx
                phi[i] = math.atan2(dy, dx) % TAU
                r[i] = math.hypot(dx, dy)
                i += 1
        self.phi = phi
        self.r = r

    def paint(self, phase, frames, base):
        magnitude = abs(math.cos(TAU * phase))
        # A third of a turn per loop: a symmetry of the triangle, so the spin
        # costs nothing at the seam -- and the halfway point of that turn is the
        # inverted pose, which is where the fold shows itself.
        period = TAU / 3.0
        rotation = period * phase
        # Inradius over circumradius for an equilateral triangle.
        ratio = math.cos(period / 2.0)
        R = self.radius
        soft = self.soft
        phi = self.phi
        r = self.r
        for i in range(self.pixels):
            a = (phi[i] + rotation) % period
            reach = R * magnitude * (ratio / math.cos(a - period / 2.0))
            put(frames, base + i, edge((r[i] - reach) / soft))


class Cross(Shape):
    """Two short bars that grow into a cross and shrink apart again.

    The pair turns a quarter turn per loop, which swaps one arm for the other
    and so lands back on the same picture.
    """

    name = "cross"
    SHORT = 0.42
    HALF_WIDTH = 0.155

    def __init__(self, w, h, args):
        super().__init__(w, h, args)
        dx = [0.0] * self.pixels
        dy = [0.0] * self.pixels
        i = 0
        for y in range(h):
            for x in range(w):
                dx[i] = x - self.cx
                dy[i] = y - self.cy
                i += 1
        self.dx = dx
        self.dy = dy

    @staticmethod
    def _bars(u: float, v: float, half_len: float, half_w: float) -> float:
        """Signed distance to a rectangle centred on the local origin."""
        qu = abs(u) - half_len
        qv = abs(v) - half_w
        return math.hypot(max(qu, 0.0), max(qv, 0.0)) + min(max(qu, qv), 0.0)

    def paint(self, phase, frames, base):
        p = 0.5 - 0.5 * math.cos(TAU * phase)
        theta = (TAU / 4.0) * phase
        c = math.cos(theta)
        s = math.sin(theta)
        half_len = self.radius * (self.SHORT + (1.0 - self.SHORT) * p)
        half_w = self.radius * self.HALF_WIDTH
        soft = self.soft
        dxs = self.dx
        dys = self.dy
        for i in range(self.pixels):
            dx = dxs[i]
            dy = dys[i]
            # Arm one along the rotated x axis, arm two along the rotated y axis.
            u = dx * c + dy * s
            v = -dx * s + dy * c
            best = edge(self._bars(u, v, half_len, half_w) / soft)
            u = -dx * s + dy * c
            v = -dx * c - dy * s
            other = edge(self._bars(u, v, half_len, half_w) / soft)
            put(frames, base + i, best if best > other else other)


class Dots(Shape):
    """A grid of dots that rearranges itself into a ring, and back.

    Painted dot by dot rather than pixel by pixel -- every dot touches a few
    hundred pixels, so walking all 25,600 of them once per dot would be about
    seventy times the work for the same picture.

    Each dot is sent to the ring position matching its rank in angle order, so
    neighbours on the grid stay neighbours on the ring and the dots slide past
    each other instead of crossing.
    """

    name = "dots"
    SIDE = 5
    DOT_RADIUS = 0.034
    GRID_SPREAD = 0.90

    def __init__(self, w, h, args):
        super().__init__(w, h, args)
        step = self.radius * self.GRID_SPREAD * 2.0 / (self.SIDE - 1)
        mid = (self.SIDE - 1) / 2.0
        cells = []
        for iy in range(self.SIDE):
            for ix in range(self.SIDE):
                gx = self.cx + (ix - mid) * step
                gy = self.cy + (iy - mid) * step
                # Rank by angle, then by distance, so the centre dot has a place
                # in the order rather than an undefined one.
                cells.append((math.atan2(gy - self.cy, gx - self.cx),
                              math.hypot(gx - self.cx, gy - self.cy), gx, gy))
        cells.sort(key=lambda cell: (cell[0], cell[1]))
        count = len(cells)
        self.dots = [(gx, gy, TAU * k / count) for k, (_, _, gx, gy) in enumerate(cells)]
        self.dot_radius = min(w, h) * self.DOT_RADIUS

    def paint(self, phase, frames, base):
        p = 0.5 - 0.5 * math.cos(TAU * phase)
        spin = (TAU / 4.0) * phase
        c = math.cos(spin)
        s = math.sin(spin)
        R = self.radius
        rd = self.dot_radius
        soft = self.soft
        cx = self.cx
        cy = self.cy
        w = self.w
        h = self.h
        for gx, gy, ring_angle in self.dots:
            ox = gx - cx
            oy = gy - cy
            sx = cx + ox * c - oy * s
            sy = cy + ox * s + oy * c
            target = ring_angle + spin
            tx = cx + R * math.cos(target)
            ty = cy + R * math.sin(target)
            x = sx + (tx - sx) * p
            y = sy + (ty - sy) * p

            reach = rd + soft
            for py in range(max(0, int(y - reach)), min(h - 1, int(y + reach)) + 1):
                row = base + py * w
                for px in range(max(0, int(x - reach)), min(w - 1, int(x + reach)) + 1):
                    put(frames, row + px, edge((math.hypot(px - x, py - y) - rd) / soft))


class Spiral(Shape):
    """A ring that unwinds into a coil and winds back up.

    The band's centreline is a function of the angle alone: `r = R * (1 - k*u)`
    where `u` runs 0..1 once around. At `k = 0` that is constant, which is the
    ring; as `k` approaches 1 the centreline sweeps from the rim down to the
    centre, which is one turn of a coil. Working in polar like that keeps the
    whole thing a single expression per pixel, where drawing an actual spiral
    stroke would need the band rasterised along its length.
    """

    name = "spiral"
    HALF_WIDTH = 0.15

    def __init__(self, w, h, args):
        super().__init__(w, h, args)
        phi = [0.0] * self.pixels
        r = [0.0] * self.pixels
        i = 0
        for y in range(h):
            dy = y - self.cy
            for x in range(w):
                dx = x - self.cx
                phi[i] = (math.atan2(dy, dx) % TAU) / TAU
                r[i] = math.hypot(dx, dy)
                i += 1
        self.phi = phi
        self.r = r

    def paint(self, phase, frames, base):
        k = 0.5 - 0.5 * math.cos(TAU * phase)
        half_w = self.radius * self.HALF_WIDTH
        R = self.radius
        soft = self.soft
        phi = self.phi
        r = self.r
        for i in range(self.pixels):
            u = phi[i] + phase
            u -= math.floor(u)
            centreline = R * (1.0 - k * u)
            put(frames, base + i, edge((abs(r[i] - centreline) - half_w) / soft))


SHAPES = {cls.name: cls for cls in (
    CometRing, Rounding, Cutout, Fold, Cross, Dots, Spiral,
)}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", required=True, help="where to write the raw frames")
    parser.add_argument("--w", type=int, required=True)
    parser.add_argument("--h", type=int, required=True)
    parser.add_argument("--frames", type=int, required=True)
    parser.add_argument(
        "--shape",
        default="comet-ring",
        choices=sorted(SHAPES),
        help="which shape to draw; the bundled default is comet-ring",
    )
    parser.add_argument(
        "--duty",
        type=float,
        default=0.14,
        help="comet-ring only: brightness of the trail's tail; 0 reaches black",
    )
    parser.add_argument(
        "--decay",
        type=float,
        default=2.2,
        help="comet-ring only: how fast the trail falls off behind the head",
    )
    args = parser.parse_args(argv)

    if args.frames < 2:
        print("--frames must be at least 2: a one-frame loop is a still image", file=sys.stderr)
        return 2

    shape = SHAPES[args.shape](args.w, args.h, args)
    pixels = args.w * args.h
    frames = bytearray(pixels * args.frames)

    for f in range(args.frames):
        # A full turn per loop, so phase 1 lands exactly on phase 0.
        shape.paint(f / args.frames, frames, f * pixels)

    with open(args.out, "wb") as handle:
        handle.write(frames)

    print(
        f"wrote {args.out}: {args.shape}, {args.w}x{args.h}, {args.frames} frames, "
        f"{len(frames):,} B of raw gray"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
