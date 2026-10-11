"""Single source of truth for the synthetic workforce dataset (SPEC sections 6.2 to 6.6).

Counts are fixed by construction. A seed changes values (names, dates within ranges,
salaries, FX paths), never row counts.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass

GENERATOR_VERSION = "1"
TZDATA_VERSION = "2026e"

CALENDAR_START = dt.date(2025, 1, 1)
CALENDAR_END = dt.date(2025, 12, 31)
CALENDAR_DAYS = (CALENDAR_END - CALENDAR_START).days + 1  # 365
MERIT_DATE = dt.date(2025, 4, 1)
LEAVER_TERMINATION = dt.date(2025, 6, 30)  # last day employed
LEAVER_INTERVAL_END = dt.date(2025, 7, 1)  # half-open interval end


@dataclass(frozen=True)
class Location:
    location_id: int
    name: str
    country_code: str
    timezone: str
    currency: str


LOCATIONS: tuple[Location, ...] = (
    Location(1, "San Jose", "US", "America/Los_Angeles", "USD"),
    Location(2, "New York", "US", "America/New_York", "USD"),
    Location(3, "Toronto", "CA", "America/Toronto", "CAD"),
    Location(4, "London", "GB", "Europe/London", "GBP"),
    Location(5, "Dublin", "IE", "Europe/Dublin", "EUR"),
    Location(6, "Berlin", "DE", "Europe/Berlin", "EUR"),
    Location(7, "Bengaluru", "IN", "Asia/Kolkata", "INR"),
    Location(8, "Singapore", "SG", "Asia/Singapore", "SGD"),
)

# Base FX rates in micro-USD per unit of currency (1e-6 USD). USD is fixed at 1.0.
CURRENCIES: tuple[str, ...] = ("CAD", "EUR", "GBP", "INR", "SGD", "USD")
FX_BASE_MICROS: dict[str, int] = {
    "USD": 1_000_000,
    "CAD": 730_000,
    "GBP": 1_270_000,
    "EUR": 1_080_000,
    "INR": 11_900,
    "SGD": 740_000,
}
FX_MAX_STEP_PPM = 5_000  # at most 0.5% per day
FX_CLAMP_DIVISOR = 10  # plus or minus 10% of the base rate

# Annual base salary ranges in major units per currency.
SALARY_RANGE_MAJOR: dict[str, tuple[int, int]] = {
    "USD": (90_000, 220_000),
    "CAD": (80_000, 170_000),
    "GBP": (55_000, 130_000),
    "EUR": (55_000, 130_000),
    "INR": (1_500_000, 6_000_000),
    "SGD": (80_000, 200_000),
}
MERIT_BP_RANGE = (200, 800)  # merit increase in basis points on 2025-04-01

DEPARTMENTS: tuple[tuple[int, str, str], ...] = (
    (1, "Engineering", "CC-100"),
    (2, "Product", "CC-110"),
    (3, "Design", "CC-120"),
    (4, "Data", "CC-130"),
    (5, "Sales", "CC-200"),
    (6, "Marketing", "CC-210"),
    (7, "Customer Success", "CC-220"),
    (8, "Finance", "CC-300"),
    (9, "People", "CC-310"),
    (10, "Legal", "CC-320"),
    (11, "Operations", "CC-400"),
    (12, "Security", "CC-410"),
)

JOB_TITLES: dict[int, tuple[str, ...]] = {
    1: ("Software Engineer", "Senior Software Engineer", "Staff Engineer"),
    2: ("Product Manager", "Senior Product Manager", "Group Product Manager"),
    3: ("Product Designer", "Senior Product Designer", "Design Lead"),
    4: ("Data Analyst", "Data Engineer", "Senior Data Scientist"),
    5: ("Account Executive", "Senior Account Executive", "Sales Manager"),
    6: ("Marketing Specialist", "Content Lead", "Marketing Manager"),
    7: ("Customer Success Manager", "Support Engineer", "CS Team Lead"),
    8: ("Financial Analyst", "Senior Accountant", "Finance Manager"),
    9: ("Recruiter", "People Partner", "People Operations Lead"),
    10: ("Legal Counsel", "Paralegal", "Senior Counsel"),
    11: ("Operations Analyst", "Program Manager", "Operations Manager"),
    12: ("Security Engineer", "Security Analyst", "Security Lead"),
}

# Employee cohorts (SPEC section 6.3).
COHORT_A = 780  # tenured: 3 assignments, 2 comp intervals, 12 payroll months
COHORT_B = 60  # leavers on 2025-06-30: 2 assignments, 1 comp interval, 6 payroll months
COHORT_C = 360  # 2025 hires, 30 per month: 1 assignment, 1 comp interval, 13 - hire month payroll months
HIRES_PER_MONTH = 30
EMPLOYEES = COHORT_A + COHORT_B + COHORT_C  # 1,200

# Recruiting (SPEC section 6.4).
REQUISITIONS = 240
APPLICATIONS_PER_REQUISITION = 20
CANDIDATES = 3_600
REPEAT_CANDIDATES = 1_200  # candidates 1..1200 apply twice

# Stage paths and their exact application counts.
PATHS: dict[str, tuple[str, ...]] = {
    "P1": ("applied", "rejected"),
    "P2": ("applied", "screen", "rejected"),
    "P3": ("applied", "screen", "onsite", "rejected"),
    "P4": ("applied", "screen", "onsite", "offer", "declined"),
    "P5": ("applied", "screen", "onsite", "offer", "hired"),
    "P6": ("applied", "withdrawn"),
}
# Requisitions 1..120 hire twice, 121..240 hire once. Per-requisition path mix:
PATH_MIX_TWO_HIRES: dict[str, int] = {"P1": 10, "P2": 5, "P3": 2, "P4": 1, "P5": 2, "P6": 0}
PATH_MIX_ONE_HIRE: dict[str, int] = {"P1": 10, "P2": 5, "P3": 3, "P4": 0, "P5": 1, "P6": 1}
TWO_HIRE_REQUISITIONS = 120

STAGE_SOURCE_SYSTEM: dict[str, str] = {
    "applied": "careers_site",
    "withdrawn": "careers_site",
    "screen": "recruiter_tool",
    "onsite": "recruiter_tool",
    "offer": "recruiter_tool",
    "rejected": "recruiter_tool",
    "declined": "recruiter_tool",
    "hired": "hris",
}
RECRUITER_DAY_START_HOUR = 9  # recruiter_tool events fall in [09:00, 18:00) local time
RECRUITER_DAY_HOURS = 9
HRIS_HIRED_LOCAL_TIME = dt.time(0, 5)  # batch job at 00:05 local on the hire date

# Exact row counts (SPEC section 6.6).
EXPECTED_COUNTS: dict[str, int] = {
    "departments": 12,
    "locations": 8,
    "employees": 1_200,
    "job_assignments": 2_820,
    "requisitions": 240,
    "candidates": 3_600,
    "applications": 4_800,
    "stage_events": 13_440,
    "offers": 480,
    "hires": 360,
    "compensation": 1_980,
    "fx_rates": 2_190,
    "payroll_lines": 12_060,
}
EXPECTED_TOTAL = 43_190

# Column kinds: int (int64), str (string), date (date32), ts (timestamp us, tz UTC), rate (decimal128(18, 6)).
TABLE_COLUMNS: dict[str, tuple[tuple[str, str], ...]] = {
    "departments": (("department_id", "int"), ("department_name", "str"), ("cost_center", "str")),
    "locations": (
        ("location_id", "int"),
        ("location_name", "str"),
        ("country_code", "str"),
        ("timezone", "str"),
        ("currency", "str"),
    ),
    "employees": (
        ("employee_id", "int"),
        ("first_name", "str"),
        ("last_name", "str"),
        ("work_email", "str"),
        ("birth_date", "date"),
        ("hire_date", "date"),
        ("termination_date", "date"),
    ),
    "job_assignments": (
        ("assignment_id", "int"),
        ("employee_id", "int"),
        ("department_id", "int"),
        ("location_id", "int"),
        ("job_title", "str"),
        ("job_level", "int"),
        ("valid_from", "date"),
        ("valid_to", "date"),
    ),
    "requisitions": (
        ("requisition_id", "int"),
        ("department_id", "int"),
        ("location_id", "int"),
        ("job_title", "str"),
        ("openings", "int"),
        ("opened_at", "ts"),
    ),
    "candidates": (
        ("candidate_id", "int"),
        ("first_name", "str"),
        ("last_name", "str"),
        ("email", "str"),
        ("phone", "str"),
        ("created_at", "ts"),
    ),
    "applications": (
        ("application_id", "int"),
        ("candidate_id", "int"),
        ("requisition_id", "int"),
        ("source_channel", "str"),
        ("applied_at", "ts"),
    ),
    "stage_events": (
        ("event_id", "int"),
        ("application_id", "int"),
        ("stage", "str"),
        ("entered_at", "ts"),
        ("source_system", "str"),
    ),
    "offers": (
        ("offer_id", "int"),
        ("application_id", "int"),
        ("offer_status", "str"),
        ("offered_at", "ts"),
        ("responded_at", "ts"),
    ),
    "hires": (
        ("hire_id", "int"),
        ("application_id", "int"),
        ("employee_id", "int"),
        ("hire_date", "date"),
    ),
    "compensation": (
        ("compensation_id", "int"),
        ("employee_id", "int"),
        ("currency", "str"),
        ("base_salary_local_minor", "int"),
        ("valid_from", "date"),
        ("valid_to", "date"),
    ),
    "fx_rates": (("currency", "str"), ("rate_date", "date"), ("rate_to_usd", "rate")),
    "payroll_lines": (
        ("payroll_line_id", "int"),
        ("employee_id", "int"),
        ("pay_month", "date"),
        ("currency", "str"),
        ("gross_pay_local_minor", "int"),
        ("paid_at", "ts"),
    ),
}

TABLE_ORDER: tuple[str, ...] = tuple(EXPECTED_COUNTS)

assert sum(EXPECTED_COUNTS.values()) == EXPECTED_TOTAL
assert set(TABLE_COLUMNS) == set(EXPECTED_COUNTS)
