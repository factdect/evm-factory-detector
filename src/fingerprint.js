// Bytecode fingerprint = the "casting pattern" a factory leaves on every token it makes.
//
//  - Minimal proxy clones (EIP-1167, 0age 44-byte, Solady, clones-with-immutable-args):
//      key = proxy:<implementation>.  The implementation is hardcoded in the clone's
//      bytecode, so these are NOT upgradeable even though scanners report "is_proxy".
//  - Everything else: key = skel:<keccak(opcode skeleton)>, where the skeleton is the
//      runtime code with every PUSH operand zeroed. Two tokens from the same template
//      differ only in immutables (PUSH32 operands), so their skeletons are identical.
//
// Limitation: Vyper keeps immutables in a data section after the code, so Vyper
// templates do not collapse to one skeleton. Solidity (the launchpad norm) does.

import { keccak256 } from 'viem';

const EIP1967_IMPL_SLOT = '360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const EIP1967_BEACON_SLOT = 'a3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const MINIMAL_PROXY_MAX_BYTES = 256;

const toBytes = (hexStr) => {
  const h = hexStr.startsWith('0x') ? hexStr.slice(2) : hexStr;
  const out = new Uint8Array(h.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
};
const toHex = (bytes) => '0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function fingerprint(codeHex) {
  if (!codeHex || codeHex === '0x') return { size: 0, kind: 'empty', key: null, exact: null, skeleton: null, impl: null, upgradeable: null };
  const code = toBytes(codeHex);
  const skel = code.slice();
  let impl = null;

  for (let i = 0; i < code.length; ) {
    const op = code[i];
    if (op >= 0x60 && op <= 0x7f) {
      const len = op - 0x5f;
      const start = i + 1;
      const end = Math.min(start + len, code.length);
      // PUSH16..PUSH20 <addr> GAS DELEGATECALL  ->  hardcoded delegate target.
      // (PUSH<20 happens when the implementation address has leading zero bytes.)
      if (impl === null && len >= 16 && len <= 20 && end === start + len && code[end] === 0x5a && code[end + 1] === 0xf4) {
        const addr = new Uint8Array(20);
        addr.set(code.subarray(start, end), 20 - len);
        impl = toHex(addr);
      }
      skel.fill(0, start, end);
      i = end;
    } else {
      i++;
    }
  }

  const exact = keccak256(toHex(code));
  const skeleton = keccak256(toHex(skel));
  const lower = codeHex.toLowerCase();

  if (impl && code.length <= MINIMAL_PROXY_MAX_BYTES) {
    return { size: code.length, kind: 'minimal-proxy', key: `proxy:${impl}`, exact, skeleton, impl, upgradeable: false };
  }
  if (lower.includes(EIP1967_IMPL_SLOT) || lower.includes(EIP1967_BEACON_SLOT)) {
    return { size: code.length, kind: 'eip1967-proxy', key: `skel:${skeleton}`, exact, skeleton, impl: null, upgradeable: true };
  }
  return { size: code.length, kind: 'contract', key: `skel:${skeleton}`, exact, skeleton, impl: null, upgradeable: null };
}
