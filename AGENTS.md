# Project working copy

The primary working folder is `D:\Coding\Remoter`.

Keep a full copy of this project at `Z:\Coding\Remoter`
(`\\192.168.2.51\work\Coding\Remoter`). Refresh that copy after making
project changes and before reporting the work complete. Include hidden files,
Git history, dependencies, and generated build output; do not exclude them from
the full copy. Copy new and updated files without deleting destination-only
files. Avoid following directory junctions outside the project.

The mapped drive may be unavailable inside the sandbox. Use the required
network/filesystem approval when accessing it; do not assume the drive is
missing from the user's session. Report any synchronization failure clearly.

# Required delivery after every iteration

After every completed project iteration, build and run the relevant checks,
commit all intended changes, and push them to GitHub. Publish a new signed
Windows release using a unique higher version whenever application changes
need distribution. Follow `docs/updates.md` and the existing release scripts;
never replace an already published release with different bytes.

Update the LAN distribution after every iteration as well. Verify that both
configured LAN feeds serve the new signed release and that its installer can
be downloaded and verified. Publishing to GitHub alone or copying source to
the network share does not establish that LAN updates are current. The mirror
servers refresh automatically after publication; allow for that refresh and
check them directly.

Refresh the full network project copy described above after all source,
Git history, dependencies, and build/release outputs are finalized. Preserve
destination-only files and avoid following external directory junctions.

The user has authorized this delivery workflow for every iteration. Do not
ask for the same publishing or synchronization permission again. Coordinate
with other active chats before releasing their in-progress edits. If a build,
check, push, publish, LAN verification, or full-copy step fails, resolve it
where possible and clearly report the remaining failure; never claim full
delivery while any required destination is stale or unverified.
