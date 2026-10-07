const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoPath = path.resolve('temp_fclogo');
const files = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: repoPath, maxBuffer: 15 * 1024 * 1024 }).toString().split('\n');

const infoFiles = files.filter(f => f.includes('/clubs/') && f.endsWith('info/info.yaml'));
console.log('Found info files:', infoFiles.length);

const leagueNames = {
  theFA: 'Premier League',
  RFEF: 'La Liga',
  FIGC: 'Serie A',
  DFB: 'Bundesliga',
  FFF: 'Ligue 1',
  AFA: 'Liga Profesional',
  CBF: 'Brasileirão',
  SAFF: 'Saudi Pro League',
  USSF: 'MLS',
  JFA: 'J.League',
  KFA: 'K League',
  FPF: 'Primeira Liga',
  CFA: 'Chinese Super League',
  FCRF: 'Liga Promerica',
  HKFA: 'Hong Kong Premier League'
};

const clubs = [];

for (const infoPath of infoFiles) {
  const parts = infoPath.split('/');
  // src/data/logos/{fed}/clubs/{clubDir}/info/info.yaml
  const fed = parts[3];
  const clubDir = parts[5];
  const logoPath = infoPath.replace('info/info.yaml', 'logo.yaml');

  let infoRaw = '';
  try {
    infoRaw = execFileSync('git', ['show', 'HEAD:' + infoPath], { cwd: repoPath }).toString();
  } catch (e) {
    continue;
  }

  let logoRaw = '';
  try {
    logoRaw = execFileSync('git', ['show', 'HEAD:' + logoPath], { cwd: repoPath }).toString();
  } catch (e) {
    continue;
  }

  const shortMatch = infoRaw.match(/shortName:\s*([^\r\n]+)/);
  const fullMatch = infoRaw.match(/fullName:\s*([^\r\n]+)/);
  const cityMatch = infoRaw.match(/city:\s*([^\r\n]+)/);
  const nationMatch = infoRaw.match(/nation:\s*([^\r\n]+)/);

  const cleanVal = (val) => val ? val.trim().replace(/^['"]|['"]$/g, '') : '';
  const shortName = shortMatch ? cleanVal(shortMatch[1]) : clubDir.replace(/^\d+_/, '');
  const fullName = fullMatch ? cleanVal(fullMatch[1]) : shortName;
  const city = cityMatch ? cleanVal(cityMatch[1]) : '';
  const nation = nationMatch ? cleanVal(nationMatch[1]) : '';

  const logoEntries = logoRaw.split(/- data: logo/g).slice(1);
  let colorSvg = null;
  let monoSvg = null;

  // Pass 1: find active (not outdated)
  for (const entry of logoEntries) {
    if (entry.includes('isOutdated: true')) continue;
    const styleMatch = entry.match(/style:\s*(\w+)/);
    const svgMatch = entry.match(/svgPath:\s*['"]([^'"]+)['"]/);
    if (!svgMatch) continue;
    const style = styleMatch ? styleMatch[1] : '';
    const svgPath = svgMatch[1];

    if (style === 'color' && !colorSvg) {
      colorSvg = svgPath;
    } else if (style === 'mono' && !monoSvg) {
      monoSvg = svgPath;
    }
  }

  // Pass 2: fallback to any if none found
  if (!colorSvg) {
    for (const entry of logoEntries) {
      const styleMatch = entry.match(/style:\s*(\w+)/);
      const svgMatch = entry.match(/svgPath:\s*['"]([^'"]+)['"]/);
      if (!svgMatch) continue;
      const style = styleMatch ? styleMatch[1] : '';
      if (style === 'color' && !colorSvg) colorSvg = svgMatch[1];
      if (style === 'mono' && !monoSvg) monoSvg = svgMatch[1];
    }
  }

  if (colorSvg) {
    const baseUrl = 'https://cdn.jsdelivr.net/gh/FCLOGO/fclogo.top@main/src/data/logos/' + fed + '/clubs/' + encodeURIComponent(clubDir) + '/';
    const aliases = new Set();
    aliases.add(shortName.toLowerCase());
    if (fullName) aliases.add(fullName.toLowerCase());
    if (city) aliases.add(city.toLowerCase());
    const simpleDir = clubDir.replace(/^\d+_/, '').toLowerCase();
    aliases.add(simpleDir);

    clubs.push({
      id: fed + '_' + clubDir.replace(/\s+/g, '_'),
      name: shortName,
      fullName: fullName,
      city: city,
      nation: nation,
      league: leagueNames[fed] || fed,
      federation: fed,
      colorUrl: baseUrl + colorSvg,
      monoUrl: monoSvg ? baseUrl + monoSvg : null,
      aliases: Array.from(aliases)
    });
  }
}

console.log('Total extracted clubs with SVGs:', clubs.length);

const outPath = path.resolve('web/src/clubsData.json');
fs.writeFileSync(outPath, JSON.stringify(clubs, null, 2), 'utf-8');
console.log('Wrote to', outPath);
