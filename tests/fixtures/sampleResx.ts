// Small .resx files in the two layouts found in MuMain/src/Localization (no game data is
// committed; the real files are tested by real-files.test.ts when they are available).

const HEADER_COMPACT = `<?xml version="1.0" encoding="utf-8"?>
<root>
  <resheader name="resmimetype"><value>text/microsoft-resx</value></resheader>
  <resheader name="version"><value>2.0</value></resheader>
`;

// Game.*.resx layout: one-line resheaders, entries with legacy_id comments.
export const GAME_EN = `${HEADER_COMPACT}  <data name="Gulim" xml:space="preserve">
    <value>Gulim</value>
    <comment>legacy_id=0,18</comment>
  </data>
  <data name="~ &lt;msg&gt;: Message to party members" xml:space="preserve">
    <value>~ &lt;msg&gt;: Message to party members</value>
    <comment>legacy_id=1</comment>
  </data>
  <data name="Warning" xml:space="preserve">
    <value>Warning!!! account(%s) ban!!\\n\\n Contact us.</value>
    <comment>legacy_id=2</comment>
  </data>
  <data name="Event" xml:space="preserve">
    <value>Event</value>
    <comment>legacy_id=3</comment>
  </data>
</root>
`;

// Dialog / Editor layout: multi-line resheaders, a blank line before the entries, no comments,
// no newline at the end of the file.
export const EDITOR_EN = `<?xml version="1.0" encoding="utf-8"?>
<root>
  <resheader name="resmimetype">
    <value>text/microsoft-resx</value>
  </resheader>

  <data name="Save Items" xml:space="preserve">
    <value>Save Items</value>
  </data>
  <data name="Index {0} is already in use" xml:space="preserve">
    <value>Index {0} is already in use</value>
  </data>
</root>`;
