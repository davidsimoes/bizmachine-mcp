# BizMachine MCP — Lessons Learned

---

## 2026-02-26 — BizMachine API response wrapping

**Context**: First enrichment run returned empty results for all companies
**Lesson**: BizMachine suggest API wraps response in `{data: [...]}` — both suggest and aggregated-data endpoints. Must unwrap with `json.data || json`.
**Rule**: Always unwrap BizMachine API responses. The pattern is `const results = json.data || json`.

## 2026-02-26 — Field is nationalIn, not nationalId

**Context**: Suggest results had ICO data but lookup was returning "no ICO in best match"
**Lesson**: BizMachine uses `nationalIn` as the field name for company identification number, not `nationalId`.
**Rule**: Access ICO via `best.nationalIn || best.nationalId` to handle both field names defensively.

## 2026-02-26 — Stale cache poisons subsequent lookups

**Context**: After fixing the API unwrapping bug, lookups still returned empty because the cache had stored empty arrays from the first failed run
**Lesson**: File-based cache stores whatever the API returned, including error states. Once cached, the fix doesn't help until cache is cleared.
**Rule**: After fixing any API parsing/response bug, always `rm -rf ~/.cache/bizmachine` to clear stale entries before re-testing.

## 2026-02-26 — Slovak companies need SK endpoint fallback

**Context**: ~15 companies in Petr's Czech e-shop list returned "not found" — many were Slovak entities
**Lesson**: Many Czech-market e-shops are operated by Slovak companies (aboutyou, belenka, dedoles, bloomrobbins, jbl, etc.). The CZ endpoint won't find them.
**Rule**: Always use `country: 'auto'` mode which tries CZ first, then falls back to SK. This is the default in the `lookup` tool.

## 2026-02-26 — Rejstřík fallback for domain-to-company mapping

**Context**: Some domains (iwant.cz, zoohit.cz, xiaomistore.cz) weren't found by BizMachine domain search because the operating company has a completely different name
**Lesson**: E-shops are often operated by companies with unrelated names (iwant.cz = Smarty CZ a.s., zoohit.cz = zooplus SE, xiaomistore.cz = Beryko.cz s.r.o.). Searching rejstřík for `"<domain>" IČO` reveals the real company.
**Rule**: Don't give up after BizMachine suggest fails. Search ARES/rejstřík for the official company name + IČO, then call `company(ico)` directly.
