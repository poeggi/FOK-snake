#!/usr/bin/env bash
# Peer-net hint: a CONTRACT test against the live server (network, not local).
#
#   bash test/peer-net.sh                 against the client's own NET_BASE
#   bash test/peer-net.sh <base-url>      against another deployment
#
# Why the client depends on this. A browser cannot see its own IP address:
# host ICE candidates are replaced by mDNS "<uuid>.local" names, and IPv6
# yields no server-reflexive candidate either (with no NAT the reflexive
# address equals the host address, so ICE prunes it as redundant). The server
# hint is therefore the ONLY source of a peer's real IPv6 -- _netDeobfuscateCand
# in js/net.js grafts it onto the peer's mDNS candidate to obtain an address
# that is actually connectable. If the hint ever stops carrying a true observed
# address, every direct IPv6 duel silently degrades to the server relay, with
# nothing in any log to say why.
#
# The test asks the deployment the same question over both families and checks
# that the answers differ accordingly: connect over IPv6, be told 6 and our
# global v6 address; connect over IPv4, be told 4 and a dotted quad. A stale,
# defaulted or hardcoded field can satisfy one of those, never both.
#
# NOT part of test/checks.sh's default tier: it needs the network and a live
# deployment, so it can neither gate a commit nor run in CI. Invoke it directly,
# or via 'bash test/checks.sh --live'. It registers two throwaway player ids
# per family, which age out under the server's normal player TTL.
set -euo pipefail
cd "$(dirname "$0")/.."

# Default to whatever the CLIENT talks to, read from the source, so the test
# target cannot drift away from the app's.
BASE="${1:-$(grep -oE "const NET_BASE = '[^']+'" js/net.js | cut -d"'" -f2)}"
BASE="${BASE%/}"
[ -n "$BASE" ] || { echo "could not determine NET_BASE"; exit 2; }

fail=0
expect() { # expect <name> <needle> <actual>
    if [[ "$3" == *"$2"* ]]; then
        echo "ok   $1"
    else
        echo "FAIL $1: expected '$2' in: $3"
        fail=1
    fi
}
# The hint must be in the peer's hands BEFORE the offer/answer it is meant to
# steer. The mailbox drains oldest-first, so it has to sit behind the accept
# that triggered it and ahead of whatever the peer sends next.
ordered() { # ordered <name> <first> <second> <actual>
    if [[ "$4" == *"$2"* && "$4" == *"$3"* && "${4%%$3*}" == *"$2"* ]]; then
        echo "ok   $1"
    else
        echo "FAIL $1: expected '$2' before '$3' in: $4"
        fail=1
    fi
}

IPOPT=""
req() { curl -s -m 15 $IPOPT "$@"; }
post() { req -X POST -H 'Content-Type: application/json' -d "$2" "$BASE$1"; }
newid() { od -An -N4 -tx1 /dev/urandom | tr -d ' \n'; }
# Field out of the peer-net payload, which arrives as JSON escaped inside the
# signal envelope: "payload":"{\"ip\":\"...\"}".
field() { echo "$2" | grep -oE "\\\\\"$1\\\\\":\\\\\"[^\\]+" | head -1 | sed 's/.*:\\"//'; }

# Registers both players, has B accept A (the signal that triggers the hint),
# then drains A's mailbox and echoes it. The bye clears the pairing again.
pair() { # pair <id-a> <id-b>
    post /api/hello.php "{\"id\":\"$1\"}" > /dev/null
    post /api/hello.php "{\"id\":\"$2\"}" > /dev/null
    post /api/signal.php "{\"id\":\"$2\",\"to\":\"$1\",\"type\":\"accept\",\"payload\":\"x\"}" > /dev/null
    req "$BASE/api/poll.php?id=$1"
}

echo "== peer-net hint at $BASE"

# ---- IPv6: the family the direct-connection graft depends on ----
IPOPT="--ipv6"
if ! req -o /dev/null "$BASE/api/t.txt"; then
    echo "SKIP no IPv6 route from this machine -- the v6 half of this test cannot run here"
else
    A=$(newid); B=$(newid)
    MB_A=$(pair "$A" "$B")
    MB_B=$(req "$BASE/api/poll.php?id=$B")
    post /api/signal.php "{\"id\":\"$B\",\"to\":\"$A\",\"type\":\"bye\",\"payload\":\"\"}" > /dev/null
    expect "over IPv6, A is told the peer's family is 6" '\"family\":6' "$MB_A"
    expect "over IPv6, A is told its own family is 6"    '\"self_family\":6' "$MB_A"
    expect "over IPv6, B is told the peer's family is 6" '\"family\":6' "$MB_B"
    ordered "the hint follows the accept that triggered it" '"type":"accept"' '"type":"peer-net"' "$MB_A"

    # Both halves must describe the same two endpoints from opposite sides:
    # what A is told about B has to equal what B is told about itself. That is
    # what proves the address is observed per client, not filled in from one row.
    PEER_OF_A=$(field ip "$MB_A"); SELF_OF_B=$(field self_ip "$MB_B")
    echo "     A is told to reach B at: $PEER_OF_A"
    if [ -n "$PEER_OF_A" ] && [ "$PEER_OF_A" = "$SELF_OF_B" ]; then
        echo "ok   both sides agree on B's address"
    else
        echo "FAIL sides disagree on B's address: A was told '$PEER_OF_A', B was told '$SELF_OF_B'"
        fail=1
    fi
    # Only a GLOBAL address is graftable onto an ICE candidate; a loopback or
    # link-local one would be worse than useless, since it would look connectable.
    case "$PEER_OF_A" in
        ::1|fe80:*|fc*|fd*) echo "FAIL not a globally scoped address: '$PEER_OF_A'"; fail=1 ;;
        *:*)                echo "ok   the address is a globally scoped IPv6 literal" ;;
        *)                  echo "FAIL not an IPv6 literal: '$PEER_OF_A'"; fail=1 ;;
    esac
fi

# ---- IPv4: the same endpoint, a different transport ----
# Not a duplicate of the above: it is what makes the IPv6 result mean something.
IPOPT="--ipv4"
A4=$(newid); B4=$(newid)
MB_A4=$(pair "$A4" "$B4")
post /api/signal.php "{\"id\":\"$B4\",\"to\":\"$A4\",\"type\":\"bye\",\"payload\":\"\"}" > /dev/null
expect "over IPv4, A is told the peer's family is 4" '\"family\":4' "$MB_A4"
expect "over IPv4, A is told its own family is 4"    '\"self_family\":4' "$MB_A4"
PEER4=$(field ip "$MB_A4")
echo "     A is told to reach B at: $PEER4"
case "$PEER4" in
    *:*) echo "FAIL an IPv4 client must be reported dotted, not v4-mapped: '$PEER4'"; fail=1 ;;
    [0-9]*.[0-9]*.[0-9]*.[0-9]*) echo "ok   the address is a dotted IPv4 literal" ;;
    *) echo "FAIL not an IPv4 literal: '$PEER4'"; fail=1 ;;
esac

echo
if [ "$fail" -ne 0 ]; then
    echo "PEER-NET CONTRACT FAILED"
    exit 1
fi
echo "PEER-NET CONTRACT OK"
