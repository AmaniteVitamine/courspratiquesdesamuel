# A lancer depuis la racine du depot courspratiquesdesamuel.
# Ne touche ni aux tarifs ni aux autres pages du site.
$ErrorActionPreference = "Stop"
$indexPath = Join-Path (Get-Location) 'index.html'
$cssPath = Join-Path (Get-Location) 'styles.css'
if (!(Test-Path $indexPath) -or !(Test-Path $cssPath)) {
  throw 'Place-toi d abord dans le dossier courspratiquesdesamuel (index.html et styles.css requis).'
}

$backupFolder = Join-Path $env:TEMP 'sauvegarde-espace-eleves'
New-Item -ItemType Directory -Path $backupFolder -Force | Out-Null
Copy-Item $indexPath (Join-Path $backupFolder 'index.html') -Force
Copy-Item $cssPath (Join-Path $backupFolder 'styles.css') -Force

$utf8 = New-Object System.Text.UTF8Encoding($false)
$index = [System.IO.File]::ReadAllText($indexPath, [System.Text.Encoding]::UTF8)
# Supprime le lien place DANS la barre de navigation, qui faisait deborder le menu.
$index = [regex]::Replace($index, '(?is)\s*<a\b[^>]*class="espace-nav-button"[^>]*>.*?</a>', '')
# Supprime l ancien bouton surdimensionne dans le bandeau de presentation.
$index = [regex]::Replace($index, '(?is)\s*<div\s+class="hero-espace-action"\s*>.*?</div>', '')
# Ajoute un lien independant juste sous l entete, qui ne modifie PAS les liens du menu.
if ($index -notmatch 'ACCES_ELEVES_V2') {
  $strip = @'

<!-- ACCES_ELEVES_V2 : emplacement independant du menu -->
<div class="student-access-strip">
  <div class="container student-access-inner">
    <span>Espace personnel pour les élèves</span>
    <a href="espace/">Accéder à mon espace <span aria-hidden="true">→</span></a>
  </div>
</div>
'@
  $index = $index.Replace('</header>', '</header>' + $strip)
}
[System.IO.File]::WriteAllText($indexPath, $index, $utf8)

$css = [System.IO.File]::ReadAllText($cssPath, [System.Text.Encoding]::UTF8)
if ($css -notmatch 'ACCES_ELEVES_V2') {
  $css += @'

/* ACCES_ELEVES_V2 — barre distincte, sans changer l'espacement du menu */
.student-access-strip {
  background:#edf4fb;
  border-bottom:1px solid #dce7f2;
}
.student-access-inner {
  display:flex;
  justify-content:flex-end;
  align-items:center;
  flex-wrap:wrap;
  gap:8px 16px;
  padding:7px 0;
  font-size:.84rem;
  color:#475569;
}
.student-access-strip a {
  font-weight:800;
  color:#1f4e85;
  text-decoration:none;
}
.student-access-strip a:hover {text-decoration:underline;}
@media (max-width:600px) {
  .student-access-inner {justify-content:space-between;font-size:.76rem;padding:10px 0;}
}
'@
}
[System.IO.File]::WriteAllText($cssPath, $css, $utf8)
Write-Host 'OK : menu restaure, lien eleves place dans sa propre barre.' -ForegroundColor Green
Write-Host "Sauvegarde des anciens fichiers : $backupFolder"
Write-Host 'Vérifie le résultat, puis publie avec git add index.html styles.css espace supabase ...'
