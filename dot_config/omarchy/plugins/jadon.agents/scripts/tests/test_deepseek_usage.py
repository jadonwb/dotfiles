import importlib.util
import importlib.machinery
from pathlib import Path
import unittest
from unittest.mock import patch,Mock
collector=Path(__file__).resolve().parents[1]/'collectors/omarchy-agent-usage-deepseek'
if not collector.exists():collector=collector.with_name('executable_'+collector.name)
spec=importlib.util.spec_from_loader('deepseek',importlib.machinery.SourceFileLoader('deepseek',str(collector)))
d=importlib.util.module_from_spec(spec);spec.loader.exec_module(d)
class DeepSeekBalance(unittest.TestCase):
 def payload(self,total='17.84',currency='USD'):
  return {'is_available':True,'balance_infos':[{'currency':currency,'total_balance':total,'granted_balance':'2.92','topped_up_balance':'14.92'}]}
 def test_actual_balance_is_not_a_spend_estimate(self):
  b=d.balance_value(self.payload());self.assertEqual(b['remaining'],17.84);self.assertFalse(b['estimated']);self.assertEqual(b['funded'],0)
 def test_currencies_are_not_summed(self):
  p=self.payload(currency='CNY');p['balance_infos'].append({'currency':'USD','total_balance':'5.50'})
  self.assertEqual(d.balance_value(p)['remaining'],5.5);self.assertEqual(d.balance_value(self.payload(currency='CNY'))['currency'],'CNY')
 def test_invalid_balance_never_appears_as_zero(self):
  for value in ['NaN','Infinity','broken']:
   with self.assertRaises(d.BalanceError):d.balance_value(self.payload(value))
  with self.assertRaises(d.BalanceError):d.balance_value({'balance_infos':[]})
 def test_outage_preserves_labeled_last_good_balance(self):
  previous={'balance':d.balance_value(self.payload()),'balanceAsOf':'2026-11-02T00:00:00Z'}
  with patch.object(d,'read_balance',side_effect=d.BalanceError('Network unavailable')):
   result=d.collect(previous);self.assertFalse(result['ready']);self.assertEqual(result['balance'],previous['balance']);self.assertIn('last successful balance',result['authHelpText'])
 def test_environment_key_avoids_export(self):
  with patch.dict(d.os.environ,{'DEEPSEEK_API_KEY':'private'}),patch.object(d.subprocess,'run') as run:
   self.assertEqual(d.api_key(),'private');run.assert_not_called()
 def test_only_active_deepseek_credential_is_read(self):
  rows='[{"integrationID":"deepseek","active":true,"value":{"type":"key","key":"private"}}]'
  with patch.dict(d.os.environ,{},clear=True),patch.object(d.subprocess,'run',return_value=Mock(returncode=0,stdout=rows)) as run:
   self.assertEqual(d.api_key(),'private');self.assertEqual(run.call_args.args[0],['opencode','auth','export','deepseek'])
