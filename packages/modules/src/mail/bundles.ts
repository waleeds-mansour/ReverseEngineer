// Mail bundles (L2-04): each conversation sorts into People (real conversations), Updates
// (notifications, shipping, accounts), Receipts (orders, invoices, payments) or Newsletters
// (lists, marketing), so the inbox reads like a person's, not a firehose. By rules over what Nook
// already keeps about the mail, never a model call per email: whether you wrote in it, a calendar
// invitation, whether the sender (or Reply-To) is someone you know, Gmail's category, the list
// and machine headers (a message's `bulk`), no-reply senders, receipt or shipping words in the
// subject from senders that sell, and whether you sent the sender to Noise. A person's mail through
// a list, a group or an alias carries a list's headers too, so the surest signs of a conversation
// decide first (M-02): a colleague, mail to a group of yours, two people talking. This file is
// the rules alone; bundle-sort.ts reads the facts.
import type { MailBundle, MailInvite } from "@hearth/db";
import { baseDomain, isMachineAddress, isRoleAddress } from "../people/domains.ts";
import { onDomains, ownDomains } from "./colleagues.ts";
import { addressKey } from "./mine.ts";

export type { MailBundle };

/** The bundles in the order the inbox shows them: People on top. */
export const BUNDLES = [
  "people",
  "updates",
  "receipts",
  "newsletters",
] as const satisfies readonly MailBundle[];

/** What the rules look at, from the conversation's messages (factsOf). */
export interface BundleFacts {
  /** You sent a message in it, from any of your accounts. */
  youWrote: boolean;
  /** One of its messages is a calendar invitation from its organizer: answered on the calendar. */
  invite: boolean;
  /** The newest message from someone else: its sender, Reply-To, subject and flags. */
  from: string;
  replyTo: string | null;
  subject: string;
  labels: readonly string[];
  /** Sent to many or by a machine, by its headers (List-Id, List-Unsubscribe, Precedence...). */
  bulk: boolean;
  /** The sender is someone you know: a person in Nook (one you've written to, or added). */
  known: boolean;
  /** Reply-To is someone you know: a person writing through a no-reply address. */
  replyKnown: boolean;
  /** You sent its sender to Noise (mail.set_lane): it's never People, unless you write in it. */
  noise: boolean;
  /** Its lane is Noise for Gmail's tab alone (a stranger outside Primary), not for a rule of yours. */
  tabNoise: boolean;
  /** The sender is a colleague: on one of your own Workspace domains (never free mail's). */
  colleague: boolean;
  /** Sent to someone at your own domain who isn't one of your accounts: a group or alias of yours. */
  toTeam: boolean;
  /** Two to MAX_TALKERS people (not you, machines, desks or mailings) wrote in it: a discussion. */
  discussion: boolean;
}

/** Gmail's tab for a message, from its labels; null when Gmail gave none. */
type Category = "personal" | "social" | "promotions" | "updates" | "forums";

export function categoryOf(labels: readonly string[]): Category | null {
  for (const l of labels) {
    const m = /^CATEGORY_(PERSONAL|SOCIAL|PROMOTIONS|UPDATES|FORUMS)$/.exec(l);
    if (m) return m[1]!.toLowerCase() as Category;
  }
  return null;
}

const localPart = (address: string) => address.slice(0, address.lastIndexOf("@")).toLowerCase();
const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();
/** "mail.amazon.co.uk" → "amazon": the name a company sends under, whatever its country. */
const brandOf = (address: string) => baseDomain(domainOf(address)).split(".")[0] ?? "";

/**
 * No-reply style senders, which a machine sends from: nobody reads what's sent back. "noreply"
 * anywhere in the name counts (messages-noreply@, noreply-abc@), and the narrow list people/
 * domains.ts keeps out of your people.
 */
const NO_REPLY =
  /(^|[._+-])(no[-_]?reply|do[-_]?not[-_]?reply|mailer-daemon|auto-?confirm(ation)?|automated|notify|notifications?|alerts?|bounces?)([._+-]|$)/;

export function isNoReply(address: string): boolean {
  return NO_REPLY.test(localPart(address)) || isMachineAddress(address);
}

/** Newsletter senders by their name (news@, digest@) or the service they send through. */
const NEWS_NAME = /^(news|newsletters?|digest|weekly|daily|editors?|briefing|bulletin)([._+-]|$)/;
const NEWS_SERVICES = new Set([
  "substack",
  "beehiiv",
  "buttondown",
  "convertkit",
  "kit",
  "ghost",
  "mailchimpapp",
  "mailerlite",
  "sendfox",
]);

const isNewsSender = (address: string) =>
  NEWS_NAME.test(localPart(address)) || NEWS_SERVICES.has(brandOf(address));

/** Machines and desks, not people: nobody expects a reply (flags.ts; also in 0008_mail_waiting). */
export const AUTOMATED =
  /^(no-?reply|do-?not-?reply|notifications?|notify|mailer-daemon|postmaster|bounces?|alerts?|news(letter)?|updates?|info|hello|support|billing|receipts?|orders?|team|marketing)([+._-][^@]*)?@/i;

/** Shops, stores and payment services you get receipts from, by the name they send under. */
const SHOPS = new Set([
  "amazon",
  "apple",
  "paypal",
  "stripe",
  "square",
  "squareup",
  "shopify",
  "ebay",
  "etsy",
  "uber",
  "lyft",
  "doordash",
  "grubhub",
  "instacart",
  "airbnb",
  "booking",
  "expedia",
  "steampowered",
  "playstation",
  "xbox",
  "microsoft",
  "google",
  "netflix",
  "spotify",
  "venmo",
  "target",
  "walmart",
  "bestbuy",
  "costco",
  "ikea",
  "aliexpress",
  "temu",
]);

/** Senders a shop's mail comes from: orders@, receipts@, billing@, payments@... */
const SHOP_NAME =
  /^(orders?|receipts?|billing|invoices?|payments?|purchases?|store|shop|sales|transactions?|auto-?confirm)([._+-]|$)/;

const isShop = (address: string) =>
  SHOPS.has(brandOf(address)) || SHOP_NAME.test(localPart(address));

/** Tools and services sending as themselves: trackers, CI, deploys, monitoring, cron, bots. */
const TOOLS =
  /^(jira|confluence|jenkins|gitlab|github|bitbucket|git|svn|sentry|ci|cd|builds?|builder|deploy(s|er|ments?)?|releases?|root|cron|crond|daemon|system|sysadmin|alerts?|alerting|alertmanager|monitor(ing|s)?|nagios|zabbix|grafana|prometheus|pagerduty|opsgenie|datadog|status|notifications?|notify|bots?|robot|automation|automated|auto|scheduler|backups?|reports?|reporting|mailer|www-data|apache|nginx|devops|ops|server|circleci|travis|buildkite|teamcity|bamboo|argocd|sonar(qube)?|dependabot|renovate|snyk)([+._-].*)?$|[._+-](bot|robot|ci|cron|daemon|alerts?|monitor(ing)?|builds?|deploy)$/;

/** A person's own address: not a machine's, a tool's, a desk's (info@), a shop's or a newsletter's. */
export const isPerson = (address: string) =>
  address.includes("@") &&
  !isNoReply(address) &&
  !AUTOMATED.test(address) &&
  !TOOLS.test(localPart(address)) &&
  !isRoleAddress(address) &&
  !isNewsSender(address) &&
  !SHOP_NAME.test(localPart(address));

/** A discussion's notices (notifications@github.com): a PR named "Fix receipts" is no receipt. */
const NOTICES = /^(notifications?|notify|notices?|alerts?)([._+-]|$)/;
/** A reply or a forward is talk about a thing, not the thing. */
const REPLY = /^\s*(re|fwd?|aw|wg|sv)\s*:/i;
/** A list's or a tracker's tag on its subjects: "[acme/web] ...", "[JIRA] ...". */
const TAGGED = /^\s*\[[^\]]+\]/;

/** What a receipt says about itself: an order, an invoice, a payment, a refund. */
const RECEIPT =
  /\b(receipts?|invoices?|order (confirmation|confirmed|received|#|no\.?|number)|your (\S+ )?order|order of\b|payment (received|confirmation|confirmed|processed|successful|sent|to)|you paid|you sent|thanks for (your )?(order|purchase)|thank you for (your )?(order|purchase|payment)|purchase (confirmation|receipt)|your purchase|billing statement|refund|subscription (renewed|confirmation|receipt)|renewal (receipt|confirmation))/i;

/** What a shipping notice says: shipped, on its way, delivered. A shipment is an update. */
const SHIPPING =
  /\b(shipped|shipping (confirmation|update|notification)|out for delivery|delivered|delivery (update|scheduled|attempt)|on (its|the) way|tracking (number|info)|track your (order|package|parcel|shipment)|dispatched|arriv(es|ing) (today|tomorrow|on|by))\b/i;

/**
 * The bundle for a conversation, by its facts. In order:
 * 1. People: you wrote in it, or it's an invitation (answered on the calendar, from a person).
 * 2. People: someone you know writing as themselves, not to many at once and not from a no-reply
 *    or a shop's address (orders@, billing@), wherever Gmail files it and whatever their company
 *    sells: their own "Invoice for September" is a conversation. And a person writing through a
 *    list, a group or an alias, its headers notwithstanding (throughList).
 * 3. Updates: shipping words from a seller (a shop by name or orders@-style address, a no-reply
 *    sender, or mail Gmail files under Updates or Promotions), before "your order" makes it a
 *    receipt.
 * 4. Receipts: receipt words from a seller, unless it's a reply, or a list's or tracker's notice
 *    that only names one.
 * 5. People: someone you know behind a no-reply or shop address, not to many at once; or a person
 *    behind a no-reply address (Reply-To is someone you know, or a person somewhere else that
 *    Gmail calls Personal).
 * 6. Mail to many: a newsletter by its sender, Promotions, a list, or a person you know's own
 *    newsletter is Newsletters; a machine's, or Gmail's Updates or Social, is Updates.
 * 7. The rest: no-reply senders are Updates; Gmail's Promotions and Forums are Newsletters, its
 *    Updates and Social are Updates; a newsletter sender is Newsletters; anyone else is People.
 * Last, Noise is your word on a sender: what would be People is Newsletters if it went to many,
 * Updates if not. Only writing in it (or moving it by hand) makes it People again. Noise only for
 * Gmail's tab does the same, but to someone you know or a person through a list (a webinar's
 * invitation in Promotions isn't People).
 */
export function bundleOf(f: BundleFacts): MailBundle {
  if (f.youWrote) return "people";
  const sorted = byRules(f);
  if (sorted !== "people") return sorted;
  const spared = f.known || f.replyKnown || throughList(f, categoryOf(f.labels));
  if (!f.noise && !(f.tabNoise && !spared)) return sorted;
  return f.bulk ? "newsletters" : "updates";
}

function byRules(f: BundleFacts): MailBundle {
  if (f.invite) return "people";
  const cat = categoryOf(f.labels);
  const machine = isNoReply(f.from);
  if (f.known && !f.bulk && !machine && !SHOP_NAME.test(localPart(f.from))) return "people";
  if (throughList(f, cat)) return "people";
  const news = isNewsSender(f.from);
  // Who a receipt comes from: a shop, a no-reply sender, or mail Gmail calls Updates or
  // Promotions that isn't a list's or a tracker's (tagged). Never a discussion's notices.
  const seller =
    !NOTICES.test(localPart(f.from)) &&
    !REPLY.test(f.subject) &&
    (isShop(f.from) ||
      machine ||
      (!TAGGED.test(f.subject) && (cat === "updates" || cat === "promotions")));
  if (seller && SHIPPING.test(f.subject)) return "updates";
  if (seller && RECEIPT.test(f.subject)) return "receipts";
  if (!f.bulk && (f.known || f.replyKnown || relayed(f, cat))) return "people";
  if (f.bulk) {
    if (machine) return news || cat === "promotions" ? "newsletters" : "updates";
    if (news || f.known || cat === "promotions") return "newsletters";
    return cat === "updates" || cat === "social" ? "updates" : "newsletters";
  }
  if (machine) return cat === "promotions" ? "newsletters" : "updates";
  if (cat === "promotions" || cat === "forums") return "newsletters";
  if (cat === "updates" || cat === "social") return "updates";
  return news ? "newsletters" : "people";
}

/**
 * A person writing as themselves through a list, a group or an alias (M-02): its headers make it
 * `bulk` like a mailing, so it takes a surer sign. From a person's own address, where Gmail says
 * Personal or Forums or gives no tab (never Updates, Social or Promotions: a tool's or a
 * company's), and one of: a discussion; a colleague's own mail, or their post to a group of
 * yours; or an outsider's mail to a group or alias of yours, in Primary or no tab (in Forums it
 * may be a newsletter to a catch-all alias, till a second person answers). A lone post to a list
 * from a stranger can't be told from their own newsletter: its first answer tells.
 */
function throughList(f: BundleFacts, cat: Category | null): boolean {
  if (!isPerson(f.from) || (cat !== null && cat !== "personal" && cat !== "forums")) return false;
  if (f.discussion) return true;
  if (f.colleague) return !f.bulk || f.toTeam;
  return f.toTeam && cat !== "forums";
}

/** More senders than this in one conversation is a busy list's thread, not a discussion. */
export const MAX_TALKERS = 8;

/**
 * A person writing through a no-reply address (a contact form, a booking page): Reply-To is a
 * person's address at another company than the sender's, and Gmail files it as Personal or not
 * at all. A notification's Reply-To is its own service's (reply+abc@reply.github.com).
 */
function relayed(f: BundleFacts, cat: Category | null): boolean {
  const to = f.replyTo?.toLowerCase();
  if (!to || !isNoReply(f.from) || (cat !== null && cat !== "personal")) return false;
  if (isNoReply(to) || isRoleAddress(to) || !to.includes("@")) return false;
  return baseDomain(domainOf(to)) !== baseDomain(domainOf(f.from));
}

/** The parts of a message the rules read. */
export interface BundleMessage {
  outbound: boolean;
  fromAddress: string;
  replyTo: string | null;
  subject: string;
  labels: readonly string[];
  bulk: boolean | null;
  invite: MailInvite | null;
  toAddresses: readonly { address: string }[];
  ccAddresses: readonly { address: string }[];
}

/**
 * A conversation's facts from its messages, oldest first: the newest one from someone else
 * decides, and anything you sent (or your own email that reached this account) makes it yours.
 * `known` holds the addresses that are someone you know (bundle-sort.ts looks them up); `noise`
 * says you sent its sender to Noise, or "tab" that it's in Noise for Gmail's tab alone; `accounts`
 * are all your accounts' addresses by addressKey (mine.ts accountAddresses): their domains make
 * colleagues.
 */
export function factsOf(
  msgs: readonly BundleMessage[],
  me: string,
  known: ReadonlySet<string>,
  noise: boolean | "tab" = false,
  accounts: ReadonlySet<string> = new Set(),
): BundleFacts {
  const mine = addressKey(me);
  const theirs = msgs.filter((m) => !m.outbound && addressKey(m.fromAddress) !== mine);
  const last = theirs.at(-1);
  const ours = ownDomains([mine, ...accounts]);
  const yours = (a: string) => addressKey(a) === mine || accounts.has(addressKey(a));
  const team = (a: { address: string }) => onDomains(a.address, ours) && !yours(a.address);
  const people = new Set(
    theirs
      .filter((m) => isPerson(m.fromAddress) && !yours(m.fromAddress))
      .map((m) => addressKey(m.fromAddress)),
  );
  const from = last?.fromAddress.toLowerCase() ?? "";
  // Reply-To naming the sender again says nothing more.
  const asked = last?.replyTo?.toLowerCase() ?? null;
  const replyTo = asked && asked !== from ? asked : null;
  return {
    youWrote: theirs.length < msgs.length,
    invite: theirs.some((m) => m.invite !== null),
    from,
    replyTo,
    subject: last?.subject ?? "",
    labels: last?.labels ?? [],
    bulk: last?.bulk === true,
    known: from !== "" && known.has(from),
    replyKnown: replyTo !== null && known.has(replyTo),
    noise: noise === true,
    tabNoise: noise === "tab",
    colleague: onDomains(from, ours),
    toTeam: last ? [...last.toAddresses, ...last.ccAddresses].some(team) : false,
    discussion: people.size > 1 && people.size <= MAX_TALKERS,
  };
}
