"""Exactly 40 dq_ checks, 1:1 with checks/registry.yml, with the SPEC 8 category counts."""

from __future__ import annotations

from collections import Counter

from datatrust.checks.registry import CATEGORY_COUNTS, load


def test_registry_has_forty_checks_with_category_counts():
    reg = load()
    assert len(reg.checks) == 40
    assert len({c.id for c in reg.checks}) == 40
    assert len({c.test for c in reg.checks}) == 40
    assert Counter(c.category for c in reg.checks) == CATEGORY_COUNTS
    assert Counter(c.kind for c in reg.checks) == {"generic": 18, "singular": 22}


def test_resume_categories_covered():
    cats = Counter(c.category for c in load().checks)
    # the five resume categories plus SQL reconciliation
    assert cats["uniqueness"] == 8
    assert cats["referential"] == 8
    assert cats["interval"] == 7
    assert cats["stage_transition"] == 7
    assert cats["compensation"] == 6
    assert cats["reconciliation"] == 4


def test_manifest_matches_registry(parsed_manifest):
    tests = [n for n in parsed_manifest["nodes"].values() if n["resource_type"] == "test"]
    assert len(tests) == 40
    assert all(t["name"].startswith("dq_") for t in tests)
    reg = load().by_test()
    assert {t["name"] for t in tests} == set(reg)
    for t in tests:
        check = reg[t["name"]]
        is_generic = "test_metadata" in t and t["test_metadata"] is not None
        assert is_generic == (check.kind == "generic"), t["name"]
        deps = set(t["depends_on"]["nodes"])
        for target in check.targets():
            assert target.node in deps, (check.id, target.node)
            model = parsed_manifest["nodes"][target.node]
            for col in target.columns:
                assert col in model["columns"], (check.id, target.node, col)


def test_models_and_contracts(parsed_manifest):
    models = [n for n in parsed_manifest["nodes"].values() if n["resource_type"] == "model"]
    assert len(models) == 29
    enforced = [m["name"] for m in models if m["config"]["contract"]["enforced"]]
    assert len(enforced) == 22
    assert sum(1 for m in enforced if m.startswith("stg_")) == 13
    assert sum(1 for m in enforced if m.startswith(("dim_", "fct_"))) == 5
    assert sum(1 for m in enforced if m.startswith("metric_")) == 4
    assert len(parsed_manifest["sources"]) == 13
