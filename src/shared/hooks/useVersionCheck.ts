import { useState, useEffect } from 'react';

import { APP_VERSION } from '@/shared/constants';
import type { InstallMode, ReleaseInfo } from '@/shared/types';

/**
 * Reads the numbers a version is ordered by: the `X.Y.Z` core, then the build
 * number of a distribution suffix such as `-kilas.3` (a fork release of the
 * upstream `X.Y.Z`, so it sorts after the plain core). Anything else counts as 0.
 */
const readVersionNumbers = (version: string): number[] => {
  const [core, suffix = ''] = version.split('-', 2);
  const coreNumbers = core.split('.').slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  while (coreNumbers.length < 3) {
    coreNumbers.push(0);
  }
  const suffixBuild = Number.parseInt(suffix.split('.').pop() ?? '', 10);
  return [...coreNumbers, Number.isFinite(suffixBuild) ? suffixBuild : 0];
};

/**
 * Compare two version strings, `X.Y.Z` with an optional `-name.N` suffix.
 * Exported for the shared version-check tests; the hook below is its consumer.
 * @returns positive if v1 > v2, negative if v1 < v2, 0 if equal
 */
export const compareVersions = (v1: string, v2: string) => {
  const parts1 = readVersionNumbers(v1);
  const parts2 = readVersionNumbers(v2);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 !== p2) return p1 - p2;
  }
  return 0;
};


export const useVersionCheck = (owner: string, repo: string) => {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [releaseInfo, setReleaseInfo] = useState<ReleaseInfo | null>(null);
  const [installMode, setInstallMode] = useState<InstallMode>('git');
  const [runningVersion, setRunningVersion] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);
  // The server's command for updating its global npm install in place: only
  // the server knows the alias it was installed under. Null until /health
  // answers, or when the server cannot tell.
  const [npmUpdateCommand, setNpmUpdateCommand] = useState<string | null>(null);

  useEffect(() => {
    const fetchHealth = async () => {
      try {
        const response = await fetch('/health');
        const data = await response.json();
        if (data.installMode === 'npm' || data.installMode === 'git') {
          setInstallMode(data.installMode);
        }
        if (typeof data.npmUpdateCommand === 'string' && data.npmUpdateCommand.length > 0) {
          setNpmUpdateCommand(data.npmUpdateCommand);
        }
        // `data.version` is the version the server process is actually running.
        // This module's `version` is baked into the frontend bundle at build
        // time, so it reflects the installed (on-disk) package. If they differ,
        // the package was updated but the server process was not restarted, and
        // DB-backed actions may silently fail until it is.
        if (typeof data.version === 'string' && data.version.length > 0) {
          setRunningVersion(data.version);
          setRestartRequired(data.version !== APP_VERSION);
        }
      } catch {
        // Default to git / no restart hint on error
      }
    };
    fetchHealth();
  }, []);

  useEffect(() => {
    const checkVersion = async () => {
      try {
        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`);
        const data = await response.json();

        // Handle the case where there might not be any releases
        if (data.tag_name) {
          const latest = data.tag_name.replace(/^v/, '');
          setLatestVersion(latest);
          // Only show update if latest version is actually newer
          setUpdateAvailable(compareVersions(latest, APP_VERSION) > 0);

          // Store release information
          setReleaseInfo({
            title: data.name || data.tag_name,
            body: data.body || '',
            htmlUrl: data.html_url || `https://github.com/${owner}/${repo}/releases/latest`,
            publishedAt: data.published_at
          });
        } else {
          // No releases found, don't show update notification
          setUpdateAvailable(false);
          setLatestVersion(null);
          setReleaseInfo(null);
        }
      } catch (error) {
        console.error('Version check failed:', error);
        // On error, don't show update notification
        setUpdateAvailable(false);
        setLatestVersion(null);
        setReleaseInfo(null);
      }
    };

    checkVersion();
    const interval = setInterval(checkVersion, 5 * 60 * 1000); // Check every 5 minutes
    return () => clearInterval(interval);
  }, [owner, repo]);

  return { updateAvailable, latestVersion, currentVersion: APP_VERSION, releaseInfo, installMode, npmUpdateCommand, runningVersion, restartRequired };
};
