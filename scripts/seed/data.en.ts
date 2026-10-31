/**
 * English wording of the demo workspace. TEXT ONLY, keyed by the stable seed
 * ids of `data.ts`: everything structural (ids, relations, offsets, statuses,
 * priorities, counts, time windows) is shared with the German set, so the two
 * data sets cannot drift apart in shape. `seedDataFor` in `./localized` merges
 * these overlays onto the German rows and refuses to run when an id is missing.
 */

export type Text<T> = Record<string, T>;

export const EN_LOCATIONS: Text<{ name: string; code: string; description: string }> = {
  seed_loc_site_campus: {
    name: "Demo Site",
    code: "DEMO",
    description: "Central demo site for AV operations.",
  },
  seed_loc_building_b: {
    name: "Demo Building A",
    code: "DEMO-A",
    description: "Technical areas and demo rooms.",
  },
  seed_loc_room_a01: {
    name: "Demo Room A.01",
    code: "A.01",
    description: "Reference room for streaming and wireless microphone tests.",
  },
  seed_loc_storage_avlager: {
    name: "Demo Storage",
    code: "DEMO-STORAGE",
    description: "Central storage area for consumables and repair material.",
  },
  seed_loc_rack_demo_1: {
    name: "Demo Rack 1",
    code: "DEMO-RACK-1",
    description: "Patch panel and network distribution.",
  },
  seed_loc_vehicle_demo_kfz1: {
    name: "Demo Van",
    code: "DEMO-VAN-1",
    description: "Service vehicle for off-site jobs and emergency call-outs.",
  },
  seed_loc_external_demo: {
    name: "Demo Rental Site",
    code: "DEMO-EXT",
    description: "External supplier premises; goods receipt and pickup.",
  },
  seed_loc_virtual_hybrid: {
    name: "Demo Hybrid Instance",
    code: "DEMO-HYBRID",
    description: "Streaming target without a physical location.",
  },
};

export const EN_VENDORS: Text<{ name: string; contact: string }> = {
  seed_vendor_demo_rental: { name: "Demo Technology North Ltd", contact: "Demo Contact A" },
  seed_vendor_buero: { name: "Demo Office Supplies Ltd", contact: "Demo Contact B" },
  seed_vendor_demo_parts: { name: "Demo Spare Parts Ltd", contact: "Demo Contact C" },
};

export const EN_PROJECTS: Text<{ name: string; slug: string; description: string }> = {
  seed_proj_hoersaaltechnik: {
    name: "Room Technology Demo",
    slug: "room-tech-demo",
    description: "Basic provision of the demo rooms: equipment, repairs, documentation.",
  },
  seed_proj_streaming: {
    name: "Streaming Procurement",
    slug: "streaming-procurement",
    description: "Encoders, network and an operating concept for hybrid teaching.",
  },
  seed_proj_logistik: {
    name: "Storage & Logistics",
    slug: "storage-logistics",
    description: "Stock keeping, shelf structure and material procurement.",
  },
  seed_proj_veranstaltung: {
    name: "Event Season 2025",
    slug: "event-season-2025",
    description: "Lecture series, open-air dates and internal productions.",
  },
  seed_proj_wartung: {
    name: "Maintenance & Upkeep",
    slug: "maintenance-upkeep",
    description: "Preventive maintenance, annual inspection and spare-parts strategy.",
  },
  seed_proj_campus_sued: {
    name: "Site Expansion",
    slug: "site-expansion",
    description: "Feasibility study for the AV equipment of the demo annex building.",
  },
};

export const EN_TASKS: Text<{ title: string; labels: string[] }> = {
  seed_task_hs_01: {
    title: "Run the 2025 projector comparison",
    labels: ["lecture-hall", "hardware"],
  },
  seed_task_hs_02: {
    title: "Take inventory of demo rooms A.01–A.12",
    labels: ["inventory"],
  },
  seed_task_hs_03: {
    title: "Draft the routing concept for streaming offerings",
    labels: ["streaming"],
  },
  seed_task_hs_04: {
    title: "Document the display resolution of demo room A.01",
    labels: ["docs"],
  },
  seed_task_hs_05: {
    title: "Retrofit wireless microphones in demo room A.01",
    labels: ["wireless", "procurement"],
  },
  seed_task_hs_06: {
    title: "Commission the document camera in demo room A.01",
    labels: ["commissioning"],
  },
  seed_task_hs_07: {
    title: "Order the scheduled screen cleaning",
    labels: ["maintenance"],
  },
  seed_task_hs_08: {
    title: "Projector A.05 failure – provide a replacement unit",
    labels: ["incident"],
  },
  seed_task_hs_09: {
    title: "Measure and record resolution values for demo room A.01",
    labels: ["docs", "measurement"],
  },
  seed_task_hs_10: {
    title: "Sign-off: lecture hall basic equipment",
    labels: ["acceptance"],
  },
  seed_task_st_01: {
    title: "Evaluate streaming encoders for demo operations",
    labels: ["streaming", "procurement"],
  },
  seed_task_st_02: {
    title: "Collect quotes for AV encoders",
    labels: ["procurement"],
  },
  seed_task_st_03: {
    title: "Plan streaming infrastructure for the site expansion",
    labels: ["streaming", "planning"],
  },
  seed_task_st_04: {
    title: "Submit funding application for budget allocation",
    labels: ["funding"],
  },
  seed_task_st_05: {
    title: "Build the hybrid-teaching test setup",
    labels: ["streaming", "test"],
  },
  seed_task_st_06: {
    title: "Extend the streaming operations manual",
    labels: ["docs"],
  },
  seed_task_lg_01: {
    title: "Take inventory of cables and adapters in stock",
    labels: ["inventory"],
  },
  seed_task_lg_02: {
    title: "Optimise the shelf layout in Demo Rack 1",
    labels: ["storage"],
  },
  seed_task_lg_03: {
    title: "Replace the label printer",
    labels: ["storage"],
  },
  seed_task_lg_04: {
    title: "Order consumables for the heating season",
    labels: ["order"],
  },
  seed_task_lg_05: {
    title: "Clear up this quarter's inventory discrepancy",
    labels: ["inventory", "audit"],
  },
  seed_task_lg_06: {
    title: "Set up a special storage area for event technology",
    labels: ["storage", "event"],
  },
  seed_task_lg_07: {
    title: "Coordinate the vehicle inspection for the Demo Van",
    labels: ["vehicle"],
  },
  seed_task_vs_01: {
    title: "Cover the lecture series – staffing plan",
    labels: ["event", "planning"],
  },
  seed_task_vs_02: {
    title: "Write the technical rider for the maths days",
    labels: ["rider"],
  },
  seed_task_vs_03: {
    title: "Power planning for the demo summer party",
    labels: ["open-air", "power"],
  },
  seed_task_vs_04: {
    title: "Finalise the moderation handover",
    labels: ["production"],
  },
  seed_task_vs_05: {
    title: "Pack the emergency case for outdoor jobs",
    labels: ["emergency"],
  },
  seed_task_vs_06: {
    title: "Review the sound reinforcement plan for the demo foyer",
    labels: ["sound"],
  },
  seed_task_vs_07: {
    title: "Book a test run with the lighting crew",
    labels: ["lighting"],
  },
  seed_task_vs_08: {
    title: "Review the 2025 season in a retrospective",
    labels: ["retrospective"],
  },
  seed_task_wa_01: {
    title: "Draw up the 2025 maintenance plan",
    labels: ["maintenance", "planning"],
  },
  seed_task_wa_02: {
    title: "Document the firmware update rollout",
    labels: ["docs", "update"],
  },
  seed_task_wa_03: {
    title: "Emergency power switchover tested",
    labels: ["power", "test"],
  },
  seed_task_wa_04: {
    title: "Water damage in demo room A.02 – order drying",
    labels: ["damage", "urgent"],
  },
  seed_task_wa_05: {
    title: "Basement air conditioning – project postponed",
    labels: ["climate"],
  },
  seed_task_wa_06: {
    title: "Check cable routes against fire-safety rules",
    labels: ["fire-safety"],
  },
  seed_task_wa_07: {
    title: "Order spare parts pack for projector mounts",
    labels: ["spare-part"],
  },
  seed_task_wa_08: {
    title: "Complete the annual inspection checklist",
    labels: ["audit"],
  },
  seed_task_su_01: {
    title: "Sketch the room concept for the demo forum",
    labels: ["planning"],
  },
  seed_task_su_02: {
    title: "Research funding for the site expansion",
    labels: ["funding", "research"],
  },
};

export const EN_TICKETS: Text<{
  title: string;
  description: string | null;
  resolution: string | null;
}> = {
  seed_tkt_01: {
    title: "Projector A.05 stays dark",
    description: "No picture on start-up, HDMI input blinks.",
    resolution: null,
  },
  seed_tkt_02: {
    title: "Wireless microphones in demo room A.01 are noisy",
    description: "Constant background noise on channels 3 and 4.",
    resolution: null,
  },
  seed_tkt_03: {
    title: "Screen in demo room A.01 replaced",
    description: "Pull cord snapped.",
    resolution: "New 4:3 screen mounted and aligned.",
  },
  seed_tkt_04: {
    title: "Additional power outlets in the demo foyer",
    description:
      "Extra outlets are needed for the sound system at the demo summer party — see attachment.",
    resolution: null,
  },
  seed_tkt_05: {
    title: "Water damage reported in demo room A.02",
    description: "Ceiling soaked through, area of about 2×3 m.",
    resolution: "Dryer set up, room closed off.",
  },
  seed_tkt_06: {
    title: "Restock the emergency case",
    description: "The material in the case is used up.",
    resolution: null,
  },
  seed_tkt_07: {
    title: "Projector in demo room A.01 flickers",
    description: "Picture flickers after about ten minutes.",
    resolution: null,
  },
  seed_tkt_08: {
    title: "Router in Demo Rack 1 replaced",
    description: "Network distribution outage.",
    resolution: "Replacement unit swapped in, configuration carried over.",
  },
  seed_tkt_09: {
    title: "Streaming encoder purchase put on hold",
    description: "Postponed until the funding decision.",
    resolution: "On hold, to be revisited after the funding notice.",
  },
  seed_tkt_10: {
    title: "Demo foyer controller does not respond",
    description: "Router and controller have no connection.",
    resolution: null,
  },
  seed_tkt_11: {
    title: "Grant access to the site extension for external crews",
    description: "Setup for the open-air event at the demo forum.",
    resolution: null,
  },
  seed_tkt_12: {
    title: "Document camera in demo room A.01 defective",
    description: "Picture stutters badly.",
    resolution: "Replacement unit delivered and put into operation.",
  },
};

export const EN_NOTES: Text<{ title: string; tags: string[]; body: string }> = {
  seed_note_01: {
    title: "Access and security concept for the demo site",
    tags: ["security", "procedure"],
    body: [
      "# Access and security concept for the demo site",
      "",
      "Every technician needs a key from the **Demo Building A series** plus clearance",
      "in the distribution list to work in technical rooms.",
      "",
      "- Off-site jobs: vehicle keys via the control desk, return within 24 h.",
      "- Work on the rack: a **second person** must be in the building.",
      "- Basement power: only by authorised electricians.",
    ].join("\n"),
  },
  seed_note_02: {
    title: "Streaming and recording guidelines",
    tags: ["streaming", "guideline"],
    body: [
      "# Streaming guidelines",
      "",
      "1. Record teaching sessions only after announcing it.",
      "2. Switch screen recording and room camera separately.",
      "3. Recordings are kept for 14 days in `Demo Hybrid Instance`.",
      "4. Never record exams or office hours.",
    ].join("\n"),
  },
  seed_note_03: {
    title: "Emergency numbers and escalation",
    tags: ["emergency"],
    body: [
      "# Escalation",
      "",
      "1. **AV control desk** – internal short dial",
      "2. **Head of technology** – then the caretaker",
      "3. **Emergency services** – for fire, water or injury call 112 **first**",
      "",
      "> Power cut during an event: check the emergency power switchover, then Demo Rack 1.",
    ].join("\n"),
  },
  seed_note_04: {
    title: "Storage conventions for Demo Storage",
    tags: ["storage", "convention"],
    body: [
      "# Storage conventions",
      "",
      "- Every shelf has a **bin label** such as `DEMO-RACK-1-F03`.",
      "- Small parts go in labelled boxes, never loose.",
      "- Repair parts move to the `RET-ALT` shelf after 90 days.",
      "- The label printer has **spare rolls** — spares are in bin F01.",
    ].join("\n"),
  },
  seed_note_05: {
    title: "Technical rider checklist",
    tags: ["rider", "checklist"],
    body: [
      "# Rider checklist",
      "",
      "- [ ] Stage: trusses, winches, loads checked",
      "- [ ] Sound: rings measured, systems flown",
      "- [ ] Video: check source resolution and connections",
      "- [ ] Power: reconcile connected loads",
      "- [ ] Staff: schedule and relief in writing",
      "- [ ] Strike: enter teardown in the strike quota",
    ].join("\n"),
  },
  seed_note_06: {
    title: "Locations and responsibilities",
    tags: ["locations", "overview"],
    body: [
      "# Locations",
      "",
      "| Location | Type | Responsible |",
      "|---|---|---|",
      "| Demo Storage | Storage | Logistics |",
      "| Demo Rack 1 | Patch panel | Network |",
      "| Demo Van | Vehicle | Field service |",
      "| Demo Rental Site | External | Purchasing |",
      "| Demo Hybrid Instance | Virtual | Streaming |",
      "",
      "## Handovers for the week",
      "",
      "- [x] Key management for Demo Storage to Logistics",
      "- [x] Rack documentation for Demo Rack 1 to Network",
      "- [ ] Vehicle handover record to Field service",
      "- [ ] Rental interface for Demo Rental Site to Purchasing",
    ].join("\n"),
  },
  seed_note_07: {
    title: "Feedback from demo operations",
    tags: ["feedback", "survey"],
    body: [
      "# Feedback from the demo period",
      "",
      "- Wireless microphones: most frequent complaint (lecturers, audience).",
      "- Streaming: demand mainly in the **first-year courses**.",
      "- Screens: shorten the cleaning interval to every six months.",
      "- Many first-year students do not know the emergency exit route.",
    ].join("\n"),
  },
  seed_note_08: {
    title: "Archive: old AV documentation",
    tags: ["archive"],
    body: [
      "# Archive",
      "",
      "Carried over from the former overview list. **No** binding",
      "information — see the current operating documentation instead.",
      "",
      "- old room list (as of 2019)",
      "- spare-parts list without stock keeping",
    ].join("\n"),
  },
};

export const EN_TIME_ENTRIES: Text<{ comment: string }> = {
  seed_time_01: { comment: "Inventory discrepancy: recounted the cable lot" },
  seed_time_02: { comment: "Tested replacement projector A.05 (in parallel with the stocktake)" },
  seed_time_03: { comment: "Packed the emergency case and updated the list" },
  seed_time_04: { comment: "Technical rider for the maths days: draft" },
  seed_time_05: { comment: "Sound reinforcement plan for the demo foyer — site visit" },
  seed_time_06: { comment: "Encoder evaluation: compared data sheets" },
};

/** `[name, unit, category, tags]` per stock row, in `seed_inv_01…31` order. */
export const EN_INVENTORY: Text<{ name: string; unit: string; category: string; tags: string[] }> =
  Object.fromEntries(
    (
      [
        ["HDMI cable 5 m", "pcs", "Cables", ["cable", "hdmi"]],
        ["HDMI cable 10 m", "pcs", "Cables", ["cable", "hdmi"]],
        ["CAT6 patch cable 2 m", "pcs", "Cables", ["cable", "network"]],
        ["LC duplex connector multimode", "pcs", "Cables", ["fiber"]],
        ["HDMI splitter 1:8", "pcs", "Signal equipment", ["splitter"]],
        ["Matrix switch 8x8", "pcs", "Signal equipment", ["matrix"]],
        ["SDI cable BNC 3 m", "pcs", "Cables", ["cable", "sdi"]],
        ["Wireless handheld transmitter", "pcs", "Microphones", ["wireless"]],
        ["Wireless bodypack transmitter", "pcs", "Microphones", ["wireless"]],
        ["Lavalier microphone", "pcs", "Microphones", ["wireless"]],
        ["Gooseneck microphone", "pcs", "Microphones", ["conference"]],
        ["Mixing desk 8-channel", "pcs", "Signal equipment", ["mixer"]],
        ["Active loudspeaker 2-way", "pcs", "Sound reinforcement", ["speaker"]],
        ["Subwoofer", "pcs", "Sound reinforcement", ["sound"]],
        ["Handheld microphone transmitter", "pcs", "Microphones", ["wireless", "reorder"]],
        ["Network switch 24-port", "pcs", "Networking", ["network"]],
        ["Patch panel 24-port", "pcs", "Networking", ["network"]],
        ["SFP module 1G", "pcs", "Networking", ["fiber"]],
        ["Projector mount universal", "pcs", "Mounting", ["mounting"]],
        ["Screen 4:3", "pcs", "Presentation", ["screen"]],
        ["Screen 16:9", "pcs", "Presentation", ["screen"]],
        ["Projector lamp", "pcs", "Spare parts", ["spare-part"]],
        ["Remote control", "pcs", "Accessories", ["accessory"]],
        ["HDMI adapter USB-C", "pcs", "Cables", ["adapter"]],
        ["Power distributor 16 A", "pcs", "Electrical", ["power"]],
        ["Cable marker set", "set", "Accessories", ["labelling"]],
        ["Transport case", "pcs", "Accessories", ["transport"]],
        ["High-visibility vest (set of 5)", "set", "Electrical", ["safety"]],
        ["Cable reel 25 m", "pcs", "Accessories", ["transport"]],
        ["Replacement projector power supply", "pcs", "Spare parts", ["spare-part", "reorder"]],
        ["Presenter with laser pointer", "pcs", "Accessories", ["goods-receipt"]],
      ] as const
    ).map(([name, unit, category, tags], i) => [
      `seed_inv_${String(i + 1).padStart(2, "0")}`,
      { name, unit, category, tags: [...tags] },
    ]),
  );
