// First setup file of every shared-run project: the package folder becomes the working folder,
// as when the package runs alone. Forks only; process.chdir throws in worker threads.
const folder = process.env.VITEST_IMPACT_CWD
if (folder) process.chdir(folder)
