import importlib.util
import importlib.machinery
from pathlib import Path
import unittest
from unittest.mock import patch
collector=Path(__file__).resolve().parents[1]/'collectors/omarchy-agent-usage-opencode-go'
if not collector.exists():collector=collector.with_name('executable_'+collector.name)
spec=importlib.util.spec_from_loader('go_usage',importlib.machinery.SourceFileLoader('go_usage',str(collector)))
go=importlib.util.module_from_spec(spec);spec.loader.exec_module(go)
class GoUsage(unittest.TestCase):
 def test_real_percentages_and_reset_windows(self):
  value={key:{'percent':percent,'resetsAt':2000000000000} for key,percent in [('rolling',20),('weekly',30),('monthly',40)]}
  self.assertEqual([x['percent'] for x in go.limits(value,now=1900000000)],[20,30,40])
  self.assertEqual([x['title'] for x in go.limits(value,now=1900000000)],['Session','Weekly','Monthly'])
  self.assertTrue(all(x['percent']==0 and not x['resetsAt'] for x in go.limits(value,now=2100000000)))
 def test_bad_response_never_becomes_zero_usage(self):
  with self.assertRaises(go.UsageError):go.limits({})
  with patch.object(go,'read_allowance',side_effect=go.UsageError('Reconnect')):
   record=go.collect();self.assertFalse(record['ready']);self.assertEqual(record['limits'],[]);self.assertEqual(record['authHelpText'],'Reconnect')
 def test_credentials_export_is_narrow_and_active_only(self):
  with patch.object(go,'command_json',return_value=[{'integrationID':'opencode-go','active':False,'value':{'type':'key','key':'old'}},{'integrationID':'opencode-go','active':True,'value':{'type':'key','key':'private'}}]) as command:
   self.assertEqual(go.connection_key(),'private');command.assert_called_once_with(['auth','export','opencode-go'])
 def test_signed_in_console_avoids_credential_export(self):
  data={'rolling':{},'weekly':{},'monthly':{}}
  with patch.object(go,'command_json',return_value={'data':{'go':data}}),patch.object(go,'connection_key') as key:
   self.assertEqual(go.read_allowance(),data);key.assert_not_called()
