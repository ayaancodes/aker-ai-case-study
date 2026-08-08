"""Grounding check: every $/% figure the copilot states must trace back to a real
number from a tool result returned that turn, or it gets flagged instead of trusted
silently. Pure unit tests against the check itself -- no API key or network needed."""

from api.chat import _check_grounding, _flatten_numbers


def _numbers_from(result):
    nums = set()
    _flatten_numbers(result, nums)
    return nums


REVENUE_RESULT = {
    "total_gross_revenue": 7703949.39,
    "total_concessions": -144087.14,
    "total_net_effective_revenue": 7559862.25,
    "by_category": [
        {"category": "subsidy", "amount": 293951.5},
        {"category": "base_rent", "amount": 6878370.9},
    ],
}


def test_exact_and_rounded_figures_pass_clean():
    nums = _numbers_from(REVENUE_RESULT)
    text = (
        "Portfolio net effective revenue is **$7.56M**, with gross revenue of "
        "$7,703,949.39 reduced by $144,087.14 in concessions."
    )
    assert _check_grounding(text, nums) == []


def test_signed_source_value_matches_positive_prose_claim():
    """Concessions are stored negative (-144087.14) but almost always stated as a
    plain positive figure in prose -- must not false-positive on the sign alone."""
    nums = _numbers_from(REVENUE_RESULT)
    assert _check_grounding("Concessions ate into revenue by $144K.", nums) == []


def test_derived_percentage_is_flagged_by_design():
    """A percentage the model computed itself (a ratio of two numbers it saw) IS
    flagged, deliberately. Ratio-of-any-two-numbers matching was tried first and it
    made fabricated percentages like 88.4% pass as grounded -- with a dozen-plus
    numbers in a typical tool result, some accidental pair divides out near almost
    any target. For a trust check, 'couldn't verify' on real arithmetic is the safe
    failure mode; waving a fabricated number through is not. The API already returns
    pct_occ etc. precomputed, so legitimate percentages usually ARE in the data."""
    nums = _numbers_from({"a": 100000, "b": 400000})
    assert _check_grounding("That's about 25% of the total.", nums) == ["25%"]


def test_fabricated_dollar_figure_is_flagged():
    nums = _numbers_from(REVENUE_RESULT)
    unverified = _check_grounding("Net effective revenue is **$9.2M** this quarter.", nums)
    assert unverified == ["$9.2M"]


def test_fabricated_percentage_is_flagged():
    nums = _numbers_from(REVENUE_RESULT)
    unverified = _check_grounding("Occupancy is running at about 88.4%.", nums)
    assert unverified == ["88.4%"]


def test_no_tool_calls_at_all_flags_any_stated_figure():
    """If the model answers with zero tool calls this turn, any $ or % claim is
    definitionally unverified -- there's nothing to trace it to. This is the exact
    shape of the original 'no leases have expired' failure: confident, ungrounded."""
    assert _check_grounding("Revenue is about $500K.", set()) == ["$500K"]


def test_no_tool_calls_and_no_numeric_claim_is_clean():
    """A correct refusal ('I don't have that data') must never get flagged just for
    having zero tool calls -- only actual $/% claims trigger this check."""
    assert _check_grounding("I don't have quarterly trend data for this portfolio.", set()) == []
