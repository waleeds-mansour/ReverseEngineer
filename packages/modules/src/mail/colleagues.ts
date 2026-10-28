// Your own domains, for telling a colleague from anyone else (bundles.ts, M-02): the domains of
// your accounts' addresses, never one that millions share. Free mail is people/domains.ts's list,
// with the providers it doesn't name yet, and hosts every tenant of a service shares
// (contoso.onmicrosoft.com is Microsoft's, not Contoso's).
import { baseDomain, isFreeMail } from "../people/domains.ts";

const SHARED = new Set(
  (
    "protonmail.ch protonmail.com fastmail.fm seznam.cz centrum.cz email.cz wp.pl o2.pl " +
    "interia.pl onet.pl posteo.de mailbox.org freenet.de zohomail.com zoho.eu yeah.net " +
    "foxmail.com sina.com sohu.com hanmail.net daum.net bk.ru list.ru inbox.ru rambler.ru " +
    "ukr.net abv.bg virgilio.it tiscali.it sfr.fr wanadoo.fr bluewin.ch juno.com aim.com " +
    "bigpond.com optusnet.com.au shaw.ca rogers.com sympatico.ca ntlworld.com " +
    "virginmedia.com blueyonder.co.uk talktalk.net mailfence.com onmicrosoft.com " +
    "googlegroups.com"
  ).split(" "),
);
/** Providers with a domain per country that people/domains.ts doesn't name: aol.co.uk, aol.de. */
const SHARED_NAMES = new Set(["aol"]);

/** Second-level suffixes people/domains.ts baseDomain doesn't know: acme.ltd.uk, a school's sch.uk. */
const MORE_TWO_LEVEL = /\.(ltd|plc|sch|nhs|police|me|mod|gob|mil|nic|nom)\.[a-z]{2}$/;

/** "mail.acme.ltd.uk" → "acme.ltd.uk"; otherwise as baseDomain. */
export function siteOf(domain: string): string {
  const d = domain.toLowerCase();
  return MORE_TWO_LEVEL.test(d) ? d.split(".").slice(-3).join(".") : baseDomain(d);
}

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();

/** A domain anyone can have an address on: free mail, or a host its tenants share. */
export function isShared(domain: string): boolean {
  const site = siteOf(domain);
  return isFreeMail(domain) || SHARED.has(site) || SHARED_NAMES.has(site.split(".")[0] ?? "");
}

/** Your own Workspace domains, from your accounts' addresses. */
export function ownDomains(addresses: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const a of addresses)
    if (a.includes("@") && !isShared(domainOf(a))) out.add(siteOf(domainOf(a)));
  return out;
}

/** Whether an address is on one of `domains` (from ownDomains). */
export const onDomains = (address: string, domains: ReadonlySet<string>) =>
  address.includes("@") && domains.has(siteOf(domainOf(address)));
