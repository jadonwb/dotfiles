"""Only inert personal collector fixtures run; native Codex is filtered out."""
import os,json,pathlib,subprocess,tempfile,unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
class PersonalRefresh(unittest.TestCase):
 def test_fixed_provider_list_ignores_updaters_and_temporary_files(self):
  with tempfile.TemporaryDirectory() as directory:
   home=pathlib.Path(directory);scripts=home/'scripts';collectors=scripts/'collectors';collectors.mkdir(parents=True)
   source=ROOT/'usage-update'
   if not source.exists():source=ROOT/'executable_usage-update'
   update=scripts/'usage-update';update.write_text(source.read_text())
   for name in ['opencode-go','deepseek']:
    p=collectors/('omarchy-agent-usage-'+name)
    p.write_text("#!/bin/sh\nprintf '%s\\n' '"+json.dumps({'id':name})+"'\necho '"+name+"' >> \"$HOME/calls\"\n");p.chmod(0o755)
   for name in ['update','update.dpkg-tmp','update.dpkg-new','deepseek.dpkg-tmp']:
    p=collectors/('omarchy-agent-usage-'+name);p.write_text('#!/bin/sh\ntouch "$HOME/UNEXPECTED"\n');p.chmod(0o755)
   env=dict(os.environ,HOME=str(home),XDG_STATE_HOME=str(home/'state'))
   result=subprocess.run(['/bin/bash',str(update),'--force','opencode-go','deepseek'],env=env,capture_output=True,text=True,timeout=5)
   self.assertEqual(result.returncode,0,result.stderr)
   self.assertFalse((home/'UNEXPECTED').exists())
   self.assertEqual(sorted((home/'calls').read_text().splitlines()),['deepseek','opencode-go'])
 def test_native_collector_is_found_from_omarchy_path(self):
  with tempfile.TemporaryDirectory() as directory:
   home=pathlib.Path(directory);scripts=home/'scripts';scripts.mkdir()
   source=ROOT/'usage-update'
   if not source.exists():source=ROOT/'executable_usage-update'
   update=scripts/'usage-update';update.write_text(source.read_text())
   runtime=home/'omarchy'/'bin';runtime.mkdir(parents=True)
   native=runtime/'omarchy-agent-usage-codex'
   native.write_text("#!/bin/sh\nprintf '%s\\n' '"+json.dumps({'id':'codex'})+"'\necho codex >> \"$HOME/calls\"\n");native.chmod(0o755)
   env=dict(os.environ,HOME=str(home),XDG_STATE_HOME=str(home/'state'),OMARCHY_PATH=str(home/'omarchy'),PATH='/usr/bin:/bin')
   result=subprocess.run(['/bin/bash',str(update),'--force','codex'],env=env,capture_output=True,text=True,timeout=5)
   self.assertEqual(result.returncode,0,result.stderr)
   self.assertEqual((home/'calls').read_text().splitlines(),['codex'])
