## 2026-10-23 - native patch: stay inside the repository

Luna review round 10 on the native `apply_patch` route. The route accepted absolute destinations, so a
patch could aim at a file elsewhere on the machine (for example under the user's home folder) and pass
the protected-file checks, which only know repository paths. A destination must now sit inside the
repository (the hook's project directory, the event working directory, or the git root above it); an
outside path, a UNC path, or a `workdir` that points at another folder is refused before any filesystem
lookup, and a link inside the repository that leads out is refused after resolution. The path-count cap
now stops the parse at the 201st path instead of after parsing the whole patch. A UNC-specific rule that
the outside-repository check made redundant was not kept.
