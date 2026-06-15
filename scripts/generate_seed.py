#!/usr/bin/env python3
"""Generate supabase/seed.sql from data/courses.json.

Idempotent: uses upserts keyed on slug / (course, name) / (course, hole_number).
Run: python3 scripts/generate_seed.py
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data", "courses.json")
OUT = os.path.join(ROOT, "supabase", "seed.sql")


def q(v):
    """SQL literal for text / null."""
    if v is None:
        return "null"
    return "'" + str(v).replace("'", "''") + "'"


def n(v):
    """SQL literal for numbers / null."""
    return "null" if v is None else str(v)


def arr(items):
    if not items:
        return "'{}'"
    inner = ",".join('"' + str(i).replace('"', '\\"') + '"' for i in items)
    return "'{" + inner + "}'"


def main():
    with open(SRC, encoding="utf-8") as f:
        data = json.load(f)

    lines = [
        "-- AUTO-GENERATED from data/courses.json by scripts/generate_seed.py",
        "-- Do not edit by hand: edit the JSON and regenerate.",
        "-- Safe to re-run (upserts on slug / natural keys).",
        "",
        "begin;",
        "",
    ]

    for c in data["courses"]:
        lines.append(f"-- {c['name']} ({c['city']})")
        lines.append(
            "insert into public.courses "
            "(slug,name,country,city,postal_code,region,website,designer,holes_count,par,lat,lng,sources,confidence,notes) values ("
            f"{q(c['slug'])},{q(c['name'])},{q(c.get('country'))},{q(c.get('city'))},"
            f"{q(c.get('postalCode'))},{q(c.get('region'))},{q(c.get('website'))},{q(c.get('designer'))},"
            f"{n(c.get('holesCount', 18))},{n(c.get('par'))},"
            f"{n(c['gps'].get('lat') if c.get('gps') else None)},{n(c['gps'].get('lng') if c.get('gps') else None)},"
            f"{arr(c.get('sources'))},{q(c.get('confidence'))},{q(c.get('notes'))}"
            ")"
        )
        lines.append(
            "on conflict (slug) do update set "
            "name=excluded.name,country=excluded.country,city=excluded.city,"
            "postal_code=excluded.postal_code,region=excluded.region,website=excluded.website,"
            "designer=excluded.designer,holes_count=excluded.holes_count,par=excluded.par,"
            "lat=excluded.lat,lng=excluded.lng,sources=excluded.sources,"
            "confidence=excluded.confidence,notes=excluded.notes,updated_at=now();"
        )
        lines.append("")

        # tees
        for i, t in enumerate(c.get("tees", []), start=1):
            lines.append(
                "insert into public.tees (course_id,name,gender,length_m,slope,course_rating,position) "
                f"select id,{q(t['name'])},{q(t.get('gender'))},{n(t.get('lengthMeters'))},"
                f"{n(t.get('slope'))},{n(t.get('courseRating'))},{i} "
                f"from public.courses where slug={q(c['slug'])} "
                "on conflict (course_id,name) do update set "
                "gender=excluded.gender,length_m=excluded.length_m,slope=excluded.slope,"
                "course_rating=excluded.course_rating,position=excluded.position;"
            )

        # holes: always emit 1..holes_count, merge known values
        known = {h["hole"]: h for h in c.get("holes", [])}
        hc = c.get("holesCount", 18)
        for hn in range(1, hc + 1):
            h = known.get(hn, {})
            lines.append(
                "insert into public.holes (course_id,hole_number,par,length_m,stroke_index) "
                f"select id,{hn},{n(h.get('par'))},{n(h.get('lengthMeters'))},{n(h.get('strokeIndex'))} "
                f"from public.courses where slug={q(c['slug'])} "
                "on conflict (course_id,hole_number) do update set "
                "par=coalesce(excluded.par,public.holes.par),"
                "length_m=coalesce(excluded.length_m,public.holes.length_m),"
                "stroke_index=coalesce(excluded.stroke_index,public.holes.stroke_index);"
            )
        lines.append("")

    lines.append("commit;")
    lines.append("")

    with open(OUT, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    print(f"Wrote {OUT}  ({len(data['courses'])} courses)")


if __name__ == "__main__":
    main()
