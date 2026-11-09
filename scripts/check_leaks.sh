#!/usr/bin/env bash
# Fails if anything from the real client project leaks into the demo. Run before every deploy.
cd "$(dirname "$0")/.."
BANNED='rahua|luminous|netsuite|supabase|unzpccpieqthowpybdwr|sb_publishable|googleusercontent|dannelz|fabian|pablo|erewhon|macy|faire|joelene|shopmy|trackstar|tlog|paymenttech|bill\.com|\bD-0[0-9]{2}\b|\bT-1[0-9]{2}\b'
hits=$(grep -rniE "$BANNED" site generator README.md netlify.toml 2>/dev/null | grep -v '^scripts/check_leaks.sh')
if [ -n "$hits" ]; then echo "LEAK CHECK FAILED:"; echo "$hits"; exit 1; fi
# parquet is binary: check its strings too
for f in site/data/*.parquet; do
  if strings "$f" | grep -qiE "$BANNED"; then echo "LEAK CHECK FAILED in $f"; exit 1; fi
done
echo "Leak check passed: no client names, systems, keys or ids in site/, generator/ or the data files."
