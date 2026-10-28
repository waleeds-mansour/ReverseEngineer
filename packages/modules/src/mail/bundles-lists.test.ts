// A person's mail through a list, a Google Group or an alias (M-02): the list's headers make it
// bulk, so the surer signs of a conversation decide first: a colleague, mail to a group of yours,
// two people talking. And the other way: mailings, tools and machines through a list stay where
// they were. Pure: no database (bundles-lists-sync.test.ts sorts them on a sync).
import { describe, expect, it } from "vitest";
import {
  type BundleFacts,
  type BundleMessage,
  bundleOf,
  factsOf,
  isPerson,
  MAX_TALKERS,
} from "./bundles.ts";

const PERSONAL = ["INBOX", "UNREAD", "CATEGORY_PERSONAL"];
const UPDATES = ["INBOX", "UNREAD", "CATEGORY_UPDATES"];
const PROMOTIONS = ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"];
const SOCIAL = ["INBOX", "UNREAD", "CATEGORY_SOCIAL"];
const FORUMS = ["INBOX", "UNREAD", "CATEGORY_FORUMS"];
const ME = "owner@example.com";

/** A message from someone else, as the rules see it, with what's given changed. */
const mail = (f: Partial<BundleFacts>): BundleFacts => ({
  youWrote: false,
  invite: false,
  from: "someone@example.org",
  replyTo: null,
  subject: "Hello",
  labels: PERSONAL,
  bulk: false,
  known: false,
  replyKnown: false,
  noise: false,
  tabNoise: false,
  colleague: false,
  toTeam: false,
  discussion: false,
  ...f,
});

const msg = (m: Partial<BundleMessage>): BundleMessage => ({
  outbound: false,
  fromAddress: "ana@friends.example",
  replyTo: null,
  subject: "Hello",
  labels: FORUMS,
  bulk: true,
  invite: null,
  toAddresses: [{ address: ME }],
  ccAddresses: [],
  ...m,
});

describe("bundleOf, through a list or group", () => {
  it("puts a person writing through a list, a group or an alias in People (M-02)", () => {
    // A colleague's post to your company's Google Group: the group's headers make it bulk.
    const dana = mail({ from: "dana@acme.example", colleague: true, toTeam: true, bulk: true });
    for (const labels of [FORUMS, PERSONAL, ["INBOX"]])
      expect([labels, bundleOf({ ...dana, labels })]).toEqual([labels, "people"]);
    // Their own mail, not to many, wherever Gmail files it but its tool and marketing tabs.
    expect(bundleOf({ ...dana, toTeam: false, bulk: false, labels: FORUMS })).toBe("people");
    // A customer writing to sales@ (a group of yours) in Primary, or with no tab.
    const pat = mail({ from: "pat@client.example", toTeam: true, bulk: true });
    for (const labels of [PERSONAL, ["INBOX"]])
      expect([labels, bundleOf({ ...pat, labels })]).toEqual([labels, "people"]);
    // The book club's post once someone else answers it: a discussion.
    const club = mail({
      from: "sam@gmail.com",
      subject: "Re: [book-club] Receipts from the trip",
      labels: FORUMS,
      bulk: true,
    });
    expect(bundleOf(club)).toBe("newsletters");
    expect(bundleOf({ ...club, discussion: true })).toBe("people");
    // Noise is your word on them, and stands.
    expect(bundleOf({ ...dana, labels: FORUMS, noise: true })).toBe("newsletters");
  });

  it("keeps a colleague's bulk mail, and anyone's in Gmail's tool and marketing tabs, out", () => {
    const dana = mail({ from: "dana@acme.example", colleague: true, toTeam: true, bulk: true });
    // Gmail's Updates or Promotions: a tool's notice, the company's marketing.
    expect(bundleOf({ ...dana, labels: UPDATES })).toBe("updates");
    expect(bundleOf({ ...dana, labels: PROMOTIONS })).toBe("newsletters");
    // Sent to many, but not to a group of yours: an outside list, or a machine's auto-mail.
    expect(bundleOf({ ...dana, toTeam: false })).toBe("newsletters");
    // To a group of yours from outside, in Forums: maybe a newsletter to a catch-all alias.
    const pat = mail({ from: "pat@client.example", toTeam: true, bulk: true, labels: FORUMS });
    expect(bundleOf(pat)).toBe("newsletters");
    expect(bundleOf({ ...pat, labels: SOCIAL })).toBe("updates");
    expect(bundleOf({ ...pat, from: "digest@vendor.example" })).toBe("newsletters");
    // A discussion's newest message from a machine sorts as that.
    const github = "notifications@github.com";
    expect(bundleOf(mail({ from: github, discussion: true, bulk: true, labels: FORUMS }))).toBe(
      "updates",
    );
    // A person's own newsletter, with nothing more, is still a newsletter.
    expect(bundleOf(mail({ from: "jane@janedoe.example", subject: "Issue 12", bulk: true }))).toBe(
      "newsletters",
    );
  });

  it("tells your company's tools, machines and desks from its people", () => {
    const tools = [
      "jira",
      "jenkins",
      "gitlab",
      "github",
      "sentry",
      "ci",
      "build",
      "builds",
      "deploy",
      "root",
      "cron",
      "alerts",
      "monitoring",
      "notifications",
      "bot",
      "deploy-bot",
      "acme-ci",
      "nightly.build",
      "jenkins+prod",
      "noreply",
      "news",
      "team",
      "orders",
    ];
    for (const name of tools) {
      const from = `${name}@build.acme.example`;
      expect([from, isPerson(from)]).toEqual([from, false]);
      // Through a group of yours, in Forums: still not a colleague's post.
      const f = mail({ from, colleague: true, toTeam: true, bulk: true, labels: FORUMS });
      expect([from, bundleOf(f)]).not.toEqual([from, "people"]);
    }
    for (const from of ["dana@acme.example", "cindy@acme.example", "rob.ott@acme.example"])
      expect([from, isPerson(from)]).toEqual([from, true]);
  });

  it("keeps a stranger in Noise for Gmail's tab out of People, but not someone you know", () => {
    // A webinar's invitation in Promotions, and a stranger's in Updates.
    const webinar = mail({
      invite: true,
      from: "events@vendor.example",
      subject: "Invitation: Scaling your sales team (webinar)",
      labels: PROMOTIONS,
      tabNoise: true,
    });
    expect(bundleOf(webinar)).toBe("updates");
    expect(bundleOf({ ...webinar, from: "boss@work.example", labels: UPDATES })).toBe("updates");
    // Someone you know, behind a service's address or as themselves.
    const docs = mail({
      from: "notifications@docs.example",
      replyTo: "ana@friends.example",
      replyKnown: true,
      labels: UPDATES,
      tabNoise: true,
    });
    expect(bundleOf(docs)).toBe("people");
    expect(bundleOf(mail({ from: "ana@friends.example", known: true, tabNoise: true }))).toBe(
      "people",
    );
    // A person through a group of yours, in Forums for the group's headers.
    const dana = mail({ from: "dana@acme.example", colleague: true, toTeam: true, bulk: true });
    expect(bundleOf({ ...dana, labels: FORUMS, tabNoise: true })).toBe("people");
  });
});

describe("factsOf, through a list or group", () => {
  it("tells a colleague by your own Workspace domains, never ones anyone can have", () => {
    const from = (fromAddress: string, me = ME, accounts = new Set<string>()) =>
      factsOf([msg({ fromAddress })], me, new Set(), false, accounts).colleague;
    expect(from("dana@example.com")).toBe(true);
    expect(from("dana@eu.example.com")).toBe(true);
    expect(from("dana@example.org")).toBe(false);
    // Your other accounts' domains too, a company's under ltd.uk included.
    expect(from("lee@acme.example", ME, new Set(["me@acme.example"]))).toBe(true);
    expect(from("lee@acme.ltd.uk", ME, new Set(["me@acme.ltd.uk"]))).toBe(true);
    expect(from("lee@other.ltd.uk", ME, new Set(["me@acme.ltd.uk"]))).toBe(false);
    // Free mail, and a host every tenant shares, make nobody your colleague.
    const shared: [string, string][] = [
      ["owner@gmail.com", "sam@gmail.com"],
      ["me@outlook.com", "sam@outlook.com"],
      ["me@protonmail.ch", "sam@protonmail.ch"],
      ["me@fastmail.fm", "sam@fastmail.fm"],
      ["me@aol.co.uk", "sam@aol.co.uk"],
      ["me@seznam.cz", "sam@seznam.cz"],
      ["me@wp.pl", "sam@wp.pl"],
      ["me@contoso.onmicrosoft.com", "sam@fabrikam.onmicrosoft.com"],
    ];
    for (const [mine, theirs] of shared)
      expect([theirs, from(theirs, mine)]).toEqual([theirs, false]);
  });

  it("tells mail to a group or alias of yours, not to you alone", () => {
    const to = (m: Partial<BundleMessage>, accounts = new Set<string>()) =>
      factsOf([msg(m)], ME, new Set(), false, accounts).toTeam;
    expect(to({ toAddresses: [{ address: "sales@example.com" }] })).toBe(true);
    expect(to({ ccAddresses: [{ address: "Dana@Example.com" }] })).toBe(true);
    expect(to({})).toBe(false);
    expect(to({ toAddresses: [{ address: "Owner+news@example.com" }] })).toBe(false);
    expect(
      to({ toAddresses: [{ address: "me@acme.example" }] }, new Set(["me@acme.example"])),
    ).toBe(false);
    expect(to({ toAddresses: [{ address: "book-club@googlegroups.com" }] })).toBe(false);
  });

  it("tells a discussion by two to a few people, not you, machines or the same person", () => {
    const talk = (from: string[], accounts = new Set<string>()) =>
      factsOf(
        from.map((fromAddress) => msg({ fromAddress })),
        ME,
        new Set(),
        false,
        accounts,
      ).discussion;
    expect(talk(["sam@gmail.com", "lee@gmail.com"])).toBe(true);
    expect(talk(["sam@gmail.com"])).toBe(false);
    expect(talk(["sam@gmail.com", "Sam+club@gmail.com"])).toBe(false);
    expect(talk(["sam@gmail.com", "notifications@github.com", "news@club.example"])).toBe(false);
    // You, from this account or another of yours, aren't the second person.
    expect(talk(["sam@gmail.com", ME])).toBe(false);
    expect(talk(["sam@gmail.com", "me@acme.example"], new Set(["me@acme.example"]))).toBe(false);
    // A busy list's thread isn't a discussion of yours.
    const many = (n: number) => Array.from({ length: n }, (_, i) => `p${i}@club.example`);
    expect(talk(many(MAX_TALKERS))).toBe(true);
    expect(talk(many(MAX_TALKERS + 1))).toBe(false);
  });

  it("tells Noise you chose from Noise for Gmail's tab", () => {
    expect(factsOf([msg({})], ME, new Set(), true)).toMatchObject({ noise: true, tabNoise: false });
    expect(factsOf([msg({})], ME, new Set(), "tab")).toMatchObject({
      noise: false,
      tabNoise: true,
    });
  });
});
