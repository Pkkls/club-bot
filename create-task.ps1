$action  = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c "C:\Users\kil\Downloads\filefs\club-bot\run-bot.cmd"'
$trigger = New-ScheduledTaskTrigger -Daily -At '21:37'
Register-ScheduledTask -TaskName 'ClubBot-cxfan' -Action $action -Trigger $trigger -Force
Write-Host "Task created OK"
