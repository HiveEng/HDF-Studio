# HDF Studio scanner bridge. Uses Windows Image Acquisition (WIA), which every
# Windows scanner driver supports. Prints one saved image path per line.
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$Dpi = 300,
  # WIA intent: 1 colour, 2 greyscale, 4 black and white (text)
  [int]$Mode = 1,
  # 1 = automatic document feeder, 0 = flatbed
  [int]$Feeder = 0,
  # 1 = show the scanner's own Windows dialog
  [int]$Dialog = 0
)
$ErrorActionPreference = 'Stop'
$BMP = '{B96B3CAB-0728-11D3-9D7B-0000F81EF32E}'
$PNG = '{B96B3CAF-0728-11D3-9D7B-0000F81EF32E}'
$JPG = '{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}'
$fmt = if ($Mode -eq 4) { $PNG } else { $JPG }
$ext = if ($Mode -eq 4) { 'png' } else { 'jpg' }

function Code($err) {
  $e = $err.Exception
  while ($e.InnerException) { $e = $e.InnerException }
  return ('0x{0:X8}' -f ($e.HResult -band 0xFFFFFFFF))
}
function SetProp($props, [int]$id, $value) {
  foreach ($p in $props) {
    if ($p.PropertyID -eq $id) { try { $p.Value = $value } catch { } ; return }
  }
}
function Convert-Image($img) {
  if ($img.FormatID -eq $fmt) { return $img }
  $ip = New-Object -ComObject WIA.ImageProcess
  $ip.Filters.Add($ip.FilterInfos.Item('Convert').FilterID)
  $ip.Filters.Item(1).Properties.Item('FormatID').Value = $fmt
  if ($fmt -eq $JPG) { $ip.Filters.Item(1).Properties.Item('Quality').Value = 85 }
  return $ip.Apply($img)
}
$script:n = 0
function Save($img) {
  $script:n++
  $img = Convert-Image $img
  $path = Join-Path $Out ('page{0:D4}.{1}' -f $script:n, $ext)
  if (Test-Path $path) { Remove-Item $path }
  $img.SaveFile($path)
  Write-Output $path
}

try {
  $dlg = New-Object -ComObject WIA.CommonDialog
  if ($Dialog -eq 1) {
    # The scanner's own window: preview, crop and settings are all there.
    $img = $dlg.ShowAcquireImage(1, $Mode, 0, $BMP, $false, $true, $false)
    if ($img) { Save $img }
    exit 0
  }
  $dev = $dlg.ShowSelectDevice(1, $false, $true)
  # 3088 document handling: 1 feeder, 2 flatbed. 3096 pages: 0 = all in the feeder.
  SetProp $dev.Properties 3088 ($(if ($Feeder -eq 1) { 1 } else { 2 }))
  if ($Feeder -eq 1) { SetProp $dev.Properties 3096 0 }
  $item = $dev.Items.Item(1)
  SetProp $item.Properties 6146 $Mode
  SetProp $item.Properties 6147 $Dpi
  SetProp $item.Properties 6148 $Dpi
  while ($true) {
    try {
      $img = $dlg.ShowTransfer($item, $BMP, $true)
    } catch {
      $c = Code $_
      # 0x80210003: the feeder is empty, which ends a feeder scan.
      if ($c -eq '0x80210003' -and $script:n -gt 0) { break }
      throw
    }
    Save $img
    if ($Feeder -ne 1) { break }
  }
  exit 0
} catch {
  [Console]::Error.WriteLine("WIA " + (Code $_) + " " + $_.Exception.Message)
  exit 1
}
