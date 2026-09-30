param(
  [string]$Mode = 'file',
  [string]$Filter = '所有文件|*.*',
  [string]$Title = '请选择',
  [string]$Initial = '',
  [string]$Log = '',
  [switch]$DryRun
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Log([string]$text) {
  if (-not $Log) { return }
  try {
    $line = (Get-Date).ToString('HH:mm:ss') + '  ' + $text + "`r`n"
    [System.IO.File]::AppendAllText($Log, $line, [System.Text.Encoding]::UTF8)
  } catch { }
}

Write-Log "start mode=$Mode title=$Title"

try {
  Add-Type -AssemblyName System.Windows.Forms | Out-Null
  Add-Type -AssemblyName System.Drawing | Out-Null
}
catch {
  Write-Log "cannot load WinForms: $($_.Exception.Message)"
  [Console]::Error.Write($_.Exception.Message)
  exit 1
}

# ---- 用一个透明的置顶窗口当父窗口，保证对话框弹到最前面 ----
$owner = $null
try {
  $owner = New-Object System.Windows.Forms.Form
  $owner.Text = $Title
  $owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
  $owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
  $owner.Size = New-Object System.Drawing.Size(1, 1)
  $owner.ShowInTaskbar = $false
  $owner.TopMost = $true
  $owner.Opacity = 0.01
  $owner.Show()
  [System.Windows.Forms.Application]::DoEvents()
}
catch {
  Write-Log "owner form failed: $($_.Exception.Message)"
}

try {
  if ($Mode -eq 'folder') {
    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    $dlg.Description = $Title
    $dlg.ShowNewFolderButton = $true
    $dlg.RootFolder = [System.Environment+SpecialFolder]::MyComputer
    if ($Initial -and (Test-Path -LiteralPath $Initial)) { $dlg.SelectedPath = $Initial }
    if ($DryRun) { [Console]::Out.Write('DRY_OK'); exit 0 }

    Write-Log 'showing folder dialog'
    if ($owner) { $owner.Activate() }
    $result = $dlg.ShowDialog($owner)
    Write-Log "folder dialog result=$result"

    if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
      [Console]::Out.Write($dlg.SelectedPath)
    }
  }
  else {
    $dlg = New-Object System.Windows.Forms.OpenFileDialog
    $dlg.Title = $Title
    $dlg.Filter = $Filter
    $dlg.Multiselect = ($Mode -eq 'files')
    $dlg.CheckFileExists = $true
    $dlg.RestoreDirectory = $true
    if ($Initial -and (Test-Path -LiteralPath $Initial)) {
      $full = (Resolve-Path -LiteralPath $Initial).Path
      if (Test-Path -LiteralPath $full -PathType Container) {
        $dlg.InitialDirectory = $full
      } else {
        $dlg.InitialDirectory = (Split-Path -Parent $full)
        $dlg.FileName = (Split-Path -Leaf $full)
      }
    }
    if ($DryRun) { [Console]::Out.Write('DRY_OK'); exit 0 }

    Write-Log 'showing file dialog'
    if ($owner) { $owner.Activate() }
    $result = $dlg.ShowDialog($owner)
    Write-Log "file dialog result=$result files=$($dlg.FileNames -join ';')"

    if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
      [Console]::Out.Write(($dlg.FileNames -join "`n"))
    }
  }
}
catch {
  Write-Log "dialog error: $($_.Exception.Message)"
  [Console]::Error.Write($_.Exception.Message)
  exit 1
}
finally {
  if ($owner) {
    try { $owner.Close(); $owner.Dispose() } catch { }
  }
}
