// Palette tables and colour transfer for the UTXO Timelapse landscape.
//
// Pure module: no three.js and no DOM. The terrain's GPU lookup tables, the legend and
// the minimap all use it, so they show exactly the colours the terrain draws.
//
// Table sources (256 entries x 8-bit sRGB, hex):
//   film, whale  site/assets/palettes.json "base" and "whale": the film's Turbo exactly as
//                the C++ renderer quantises it (buv::ColorMap stores uint8(256 * x)) and its
//                white-hot variant (ColorMap::applyWhiteHotTail from index 180).
//   turbo        Google Turbo (Apache-2.0) from matplotlib 3.9.2 _cm_listed.py, round(255 * x).
//                Within one level of "film" in every channel; "film" is the film's exact table.
//   viridis, inferno, magma, plasma (CC0, Smith and van der Walt) and cividis (Nunez,
//                Anderton and Renslow), from matplotlib 3.9.2 _cm_listed.py, round(255 * x).
// Tests: landscape/tests/terrain-palette.test.mjs compares film/whale with
// site/assets/palettes.json and the transfer with the C++ DensityToImage code.

const TABLES = {
  film:
    '30123b31154233184a341b51351e5836215f37246638266c3929733a2c793b2f803c32863d358b3e38913e3a973f3d9c' +
    '4040a24043a74146ac4248b1424bb6434eba4351bf4453c34456c74559cb455bcf455ed34561d74663da4666dd4669e1' +
    '466be4466ee74671e94673ec4676ee4678f1467bf3467df54680f74682f94685fa4587fc458afd448cfe448ffe4391ff' +
    '4294ff4196ff3f99ff3e9bff3d9efe3ba1fd3aa3fd38a6fb36a8fa35abf933adf731b0f62fb2f42db5f22cb7f02ab9ee' +
    '28bcec26beea25c0e723c3e521c5e220c7e01fc9dd1dccdb1cced81bd0d51ad2d319d4d018d6cd18d8cb18dac817dbc5' +
    '17ddc317dfc018e0be18e2bb19e3b91ae5b71be6b41de8b21ee9af20eaad22ecaa24eda727eea429efa12cf09e2ff19b' +
    '32f29835f39438f4913cf58e3ff68b43f78746f8844af9804efa7d51fa7955fb7659fc735dfc6f61fd6c65fd6969fe65' +
    '6dfe6271fe5f75ff5c79ff597dff5680ff5384ff5088ff4e8bff4b8fff4992ff4696ff4499ff429cfe409ffe3ea2fd3d' +
    'a4fd3ba7fc3aaafc39acfb38affa37b1f936b4f835b7f835b9f634bcf534bff434c1f334c4f233c6f033c9ef34cbee34' +
    'ceec34d0eb34d2e934d5e835d7e635d9e435dbe236dde136e0df37e2dd37e4db38e6d938e7d738e9d539ebd339edd139' +
    'eecf3af0cd3af1cb3af3c93af4c73af5c53af7c33af8c13af9bf39fabd39faba38fbb838fcb637fcb436fdb135fdaf35' +
    'feac34fea933fea732fea431ffa12fff9e2eff9c2dff992cfe962bfe932afe9028fe8d27fd8a26fd8724fc8423fc8122' +
    'fb7e20fb7b1ffa781ef9751cf8721bf86f1af76c19f66917f56616f46315f36014f25d13f05b11ef5810ee550fed530e' +
    'eb500eea4e0de94b0ce7490be6470ae4450ae34209e14009df3e08de3c07dc3a07da3806d83606d63405d43205d23105' +
    'd02f04ce2d04cc2b03ca2903c82803c62602c32402c12302bf2102bc1f01ba1e01b71c01b41b01b21901af1801ac1601' +
    'aa1501a71401a41201a111019e10019b0f01980d01950c01920b018e0a018b09018808018507018106027e05027a0402',
  whale:
    '30123b31154233184a341b51351e5836215f37246638266c3929733a2c793b2f803c32863d358b3e38913e3a973f3d9c' +
    '4040a24043a74146ac4248b1424bb6434eba4351bf4453c34456c74559cb455bcf455ed34561d74663da4666dd4669e1' +
    '466be4466ee74671e94673ec4676ee4678f1467bf3467df54680f74682f94685fa4587fc458afd448cfe448ffe4391ff' +
    '4294ff4196ff3f99ff3e9bff3d9efe3ba1fd3aa3fd38a6fb36a8fa35abf933adf731b0f62fb2f42db5f22cb7f02ab9ee' +
    '28bcec26beea25c0e723c3e521c5e220c7e01fc9dd1dccdb1cced81bd0d51ad2d319d4d018d6cd18d8cb18dac817dbc5' +
    '17ddc317dfc018e0be18e2bb19e3b91ae5b71be6b41de8b21ee9af20eaad22ecaa24eda727eea429efa12cf09e2ff19b' +
    '32f29835f39438f4913cf58e3ff68b43f78746f8844af9804efa7d51fa7955fb7659fc735dfc6f61fd6c65fd6969fe65' +
    '6dfe6271fe5f75ff5c79ff597dff5680ff5384ff5088ff4e8bff4b8fff4992ff4696ff4499ff429cfe409ffe3ea2fd3d' +
    'a4fd3ba7fc3aaafc39acfb38affa37b1f936b4f835b7f835b9f634bcf534bff434c1f334c4f233c6f033c9ef34cbee34' +
    'ceec34d0eb34d2e934d5e835d7e635d9e435dbe236dde136e0df37e2dd37e4db38e6d938e7d738e9d539ebd339edd139' +
    'eecf3af0cd3af1cb3af3c93af4c73af5c53af7c33af8c13af9bf39fabd39faba38fbb838fcb637fcb436fdb135fdaf35' +
    'feac34fea933fea732fea431ffa12fffa133ffa136ffa03afea03ffea143fea146fea14bfda14ffda252fda356fda35a' +
    'fca45dfca561fca665fba768fba86cfba970fbaa73faab76faad7afaae7df9b081f9b184f9b387f8b48af8b68df8b790' +
    'f8b994f8bb96f8bc99f7be9cf7c09ff7c2a1f7c3a4f7c5a7f7c7aaf7c9acf7caaff7ccb1f7ceb3f7d0b6f7d2b8f7d3ba' +
    'f7d5bcf8d7bff8d8c1f8dac3f8dcc5f8ddc7f9dfc8f9e0caf9e2ccf9e3cefae5cffae6d1fae7d2fbe9d4fbead5fbebd6' +
    'fcecd7fcedd8fceed9fdefdafdf0dbfdf1dcfef2ddfef2ddfef3defef4dffef4dffff4dffff5e0fff5e0fff5e0fff5e0',
  turbo:
    '30123b32154333184a341b51351e5836215f37246638276d392a733a2d793b2f803c32863d358b3e38913f3b973f3e9c' +
    '4040a24143a74146ac4249b1424bb5434eba4451bf4454c34456c74559cb455ccf455ed34661d64664da4666dd4669e0' +
    '466be3476ee64771e94773eb4776ee4778f0477bf2467df44680f64682f84685fa4687fb458afc458cfd448ffe4391fe' +
    '4294ff4196ff4099ff3e9bfe3d9efe3ba0fd3aa3fc38a5fb37a8fa35abf833adf731aff52fb2f42eb4f22cb7f02ab9ee' +
    '28bceb27bee925c0e723c3e422c5e220c7df1fc9dd1ecbda1ccdd81bd0d51ad2d21ad4d019d5cd18d7ca18d9c818dbc5' +
    '18ddc218dec018e0bd19e2bb19e3b91ae4b61ce6b41de7b21fe9af20eaac22ebaa25eca727eea42aefa12cf09e2ff19b' +
    '32f29835f39438f4913cf58e3ff68a43f78746f8844af8804ef97d52fa7a55fa7659fb735dfc6f61fc6c65fd6969fd66' +
    '6dfe6271fe5f75fe5c79fe597dff5680ff5384ff5188ff4e8bff4b8fff4992ff4796fe4499fe429cfe409ffd3fa1fd3d' +
    'a4fc3ca7fc3aa9fb39acfb38affa37b1f936b4f836b7f735b9f635bcf534bef434c1f334c3f134c6f034c8ef34cbed34' +
    'cdec34d0ea34d2e935d4e735d7e535d9e436dbe236dde037dfdf37e1dd37e3db38e5d938e7d739e9d539ebd339ecd13a' +
    'eecf3aefcd3af1cb3af2c93af4c73af5c53af6c33af7c13af8be39f9bc39faba39fbb838fbb637fcb336fcb136fdae35' +
    'fdac34fea933fea732fea431fea130fe9e2ffe9b2dfe992cfe962bfe932afe9029fd8d27fd8a26fc8725fc8423fb8122' +
    'fb7e21fa7b1ff9781ef9751df8721cf76f1af66c19f56918f46617f36315f26014f15d13f05b12ef5811ed5510ec530f' +
    'eb500eea4e0de84b0ce7490ce5470be4450ae2430ae14109df3f08dd3d08dc3b07da3907d83706d63506d43305d23105' +
    'd02f05ce2d04cc2b04ca2a04c82803c52603c32503c12302be2102bc2002b91e02b71d02b41b01b21a01af1801ac1701' +
    'a91601a71401a41301a112019e10019b0f01980e01950d01920b018e0a018b09028808028507028106027e05027a0403',
  viridis:
    '44015444025645045745055946075a46085c460a5d460b5e470d60470e61471063471164471365481467481668481769' +
    '48186a481a6c481b6d481c6e481d6f481f70482071482173482374482475482576482677482878482979472a7a472c7a' +
    '472d7b472e7c472f7d46307e46327e46337f463480453581453781453882443983443a83443b84433d84433e85423f85' +
    '4240864241864142874144874045884046883f47883f48893e49893e4a893e4c8a3d4d8a3d4e8a3c4f8a3c508b3b518b' +
    '3b528b3a538b3a548c39558c39568c38588c38598c375a8c375b8d365c8d365d8d355e8d355f8d34608d34618d33628d' +
    '33638d32648e32658e31668e31678e31688e30698e306a8e2f6b8e2f6c8e2e6d8e2e6e8e2e6f8e2d708e2d718e2c718e' +
    '2c728e2c738e2b748e2b758e2a768e2a778e2a788e29798e297a8e297b8e287c8e287d8e277e8e277f8e27808e26818e' +
    '26828e26828e25838e25848e25858e24868e24878e23888e23898e238a8d228b8d228c8d228d8d218e8d218f8d21908d' +
    '21918c20928c20928c20938c1f948c1f958b1f968b1f978b1f988b1f998a1f9a8a1e9b8a1e9c891e9d891f9e891f9f88' +
    '1fa0881fa1881fa1871fa28720a38620a48621a58521a68522a78522a88423a98324aa8325ab8225ac8226ad8127ad81' +
    '28ae8029af7f2ab07f2cb17e2db27d2eb37c2fb47c31b57b32b67a34b67935b77937b87838b9773aba763bbb753dbc74' +
    '3fbc7340bd7242be7144bf7046c06f48c16e4ac16d4cc26c4ec36b50c46a52c56954c56856c66758c7655ac8645cc863' +
    '5ec96260ca6063cb5f65cb5e67cc5c69cd5b6ccd5a6ece5870cf5773d05675d05477d1537ad1517cd2507fd34e81d34d' +
    '84d44b86d54989d5488bd6468ed64590d74393d74195d84098d83e9bd93c9dd93ba0da39a2da37a5db36a8db34aadc32' +
    'addc30b0dd2fb2dd2db5de2bb8de29bade28bddf26c0df25c2df23c5e021c8e020cae11fcde11dd0e11cd2e21bd5e21a' +
    'd8e219dae319dde318dfe318e2e418e5e419e7e419eae51aece51befe51cf1e51df4e61ef6e620f8e621fbe723fde725',
  inferno:
    '00000401000501010601010802010a02020c02020e03021004031204031405041706041907051b08051d09061f0a0722' +
    '0b07240c08260d08290e092b10092d110a30120a32140b34150b37160b39180c3c190c3e1b0c411c0c431e0c451f0c48' +
    '210c4a230c4c240c4f260c51280b53290b552b0b572d0b592f0a5b310a5c320a5e340a5f3609613809623909633b0964' +
    '3d09653e0966400a67420a68440a68450a69470b6a490b6a4a0c6b4c0c6b4d0d6c4f0d6c510e6c520e6d540f6d550f6d' +
    '57106e59106e5a116e5c126e5d126e5f136e61136e62146e64156e65156e67166e69166e6a176e6c186e6d186e6f196e' +
    '71196e721a6e741a6e751b6e771c6d781c6d7a1d6d7c1d6d7d1e6d7f1e6c801f6c82206c84206b85216b87216b88226a' +
    '8a226a8c23698d23698f24699025689225689326679526679727669827669a28659b29649d29649f2a63a02a63a22b62' +
    'a32c61a52c60a62d60a82e5fa92e5eab2f5ead305dae305cb0315bb1325ab3325ab43359b63458b73557b93556ba3655' +
    'bc3754bd3853bf3952c03a51c13a50c33b4fc43c4ec63d4dc73e4cc83f4bca404acb4149cc4248ce4347cf4446d04545' +
    'd24644d34743d44842d54a41d74b3fd84c3ed94d3dda4e3cdb503bdd513ade5238df5337e05536e15635e25734e35933' +
    'e45a31e55c30e65d2fe75e2ee8602de9612bea632aeb6429eb6628ec6726ed6925ee6a24ef6c23ef6e21f06f20f1711f' +
    'f1731df2741cf3761bf37819f47918f57b17f57d15f67e14f68013f78212f78410f8850ff8870ef8890cf98b0bf98c0a' +
    'f98e09fa9008fa9207fa9407fb9606fb9706fb9906fb9b06fb9d07fc9f07fca108fca309fca50afca60cfca80dfcaa0f' +
    'fcac11fcae12fcb014fcb216fcb418fbb61afbb81dfbba1ffbbc21fbbe23fac026fac228fac42afac62df9c72ff9c932' +
    'f9cb35f8cd37f8cf3af7d13df7d340f6d543f6d746f5d949f5db4cf4dd4ff4df53f4e156f3e35af3e55df2e661f2e865' +
    'f2ea69f1ec6df1ed71f1ef75f1f179f2f27df2f482f3f586f3f68af4f88ef5f992f6fa96f8fb9af9fc9dfafda1fcffa4',
  magma:
    '00000401000501010601010802010902020b02020d03030f03031204041405041606051806051a07061c08071e090720' +
    '0a08220b09240c09260d0a290e0b2b100b2d110c2f120d31130d34140e36150e38160f3b180f3d19103f1a10421c1044' +
    '1d11471e114920114b21114e22115024125325125527125829115a2a115c2c115f2d11612f1163311165331067341069' +
    '36106b38106c390f6e3b0f703d0f713f0f72400f74420f75440f764510774710784910784a10794c117a4e117b4f127b' +
    '51127c52137c54137d56147d57157e59157e5a167e5c167f5d177f5f187f601880621980641a80651a80671b80681c81' +
    '6a1c816b1d816d1d816e1e81701f81721f817320817521817621817822817922827b23827c23827e2482802582812581' +
    '8326818426818627818827818928818b29818c29818e2a81902a81912b81932b80942c80962c80982d80992d809b2e7f' +
    '9c2e7f9e2f7fa02f7fa1307ea3307ea5317ea6317da8327daa337dab337cad347cae347bb0357bb2357bb3367ab5367a' +
    'b73779b83779ba3878bc3978bd3977bf3a77c03a76c23b75c43c75c53c74c73d73c83e73ca3e72cc3f71cd4071cf4070' +
    'd0416fd2426fd3436ed5446dd6456cd8456cd9466bdb476adc4869de4968df4a68e04c67e24d66e34e65e44f64e55064' +
    'e75263e85362e95462ea5661eb5760ec5860ed5a5fee5b5eef5d5ef05f5ef1605df2625df2645cf3655cf4675cf4695c' +
    'f56b5cf66c5cf66e5cf7705cf7725cf8745cf8765cf9785df9795df97b5dfa7d5efa7f5efa815ffb835ffb8560fb8761' +
    'fc8961fc8a62fc8c63fc8e64fc9065fd9266fd9467fd9668fd9869fd9a6afd9b6bfe9d6cfe9f6dfea16efea36ffea571' +
    'fea772fea973feaa74feac76feae77feb078feb27afeb47bfeb67cfeb77efeb97ffebb81febd82febf84fec185fec287' +
    'fec488fec68afec88cfeca8dfecc8ffecd90fecf92fed194fed395fed597fed799fed89afdda9cfddc9efddea0fde0a1' +
    'fde2a3fde3a5fde5a7fde7a9fde9aafdebacfcecaefceeb0fcf0b2fcf2b4fcf4b6fcf6b8fcf7b9fcf9bbfcfbbdfcfdbf',
  plasma:
    '0d088710078813078916078a19068c1b068d1d068e20068f2206902406912605912805922a05932c05942e05952f0596' +
    '31059733059735049837049938049a3a049a3c049b3e049c3f049c41049d43039e44039e46039f48039f4903a04b03a1' +
    '4c02a14e02a25002a25102a35302a35502a45601a45801a45901a55b01a55c01a65e01a66001a66100a76300a76400a7' +
    '6600a76700a86900a86a00a86c00a86e00a86f00a87100a87201a87401a87501a87701a87801a87a02a87b02a87d03a8' +
    '7e03a88004a88104a78305a78405a78606a68707a68808a68a09a58b0aa58d0ba58e0ca48f0da4910ea3920fa39410a2' +
    '9511a19613a19814a099159f9a169f9c179e9d189d9e199da01a9ca11b9ba21d9aa31e9aa51f99a62098a72197a82296' +
    'aa2395ab2494ac2694ad2793ae2892b02991b12a90b22b8fb32c8eb42e8db52f8cb6308bb7318ab83289ba3388bb3488' +
    'bc3587bd3786be3885bf3984c03a83c13b82c23c81c33d80c43e7fc5407ec6417dc7427cc8437bc9447aca457acb4679' +
    'cc4778cc4977cd4a76ce4b75cf4c74d04d73d14e72d24f71d35171d45270d5536fd5546ed6556dd7566cd8576bd9586a' +
    'da5a6ada5b69db5c68dc5d67dd5e66de5f65de6164df6263e06363e16462e26561e26660e3685fe4695ee56a5de56b5d' +
    'e66c5ce76e5be76f5ae87059e97158e97257ea7457eb7556eb7655ec7754ed7953ed7a52ee7b51ef7c51ef7e50f07f4f' +
    'f0804ef1814df1834cf2844bf3854bf3874af48849f48948f58b47f58c46f68d45f68f44f79044f79143f79342f89441' +
    'f89540f9973ff9983ef99a3efa9b3dfa9c3cfa9e3bfb9f3afba139fba238fca338fca537fca636fca835fca934fdab33' +
    'fdac33fdae32fdaf31fdb130fdb22ffdb42ffdb52efeb72dfeb82cfeba2cfebb2bfebd2afebe2afec029fdc229fdc328' +
    'fdc527fdc627fdc827fdca26fdcb26fccd25fcce25fcd025fcd225fbd324fbd524fbd724fad824fada24f9dc24f9dd25' +
    'f8df25f8e125f7e225f7e425f6e626f6e826f5e926f5eb27f4ed27f3ee27f3f027f2f227f1f426f1f525f0f724f0f921',
  cividis:
    '00224e00234f00245100255300255400265600275800285900285b00295d002a5f002a61002b62002c64002c66002d68' +
    '002e6a002e6c002f6d00306f0030700031700031710132710533710833700c34700f357012357014367016377018376f' +
    '1a386f1c396f1e3a6f203a6f213b6e233c6e243c6e263d6e273e6e293f6e2a3f6d2b406d2d416d2e416d2f426d31436d' +
    '32436d33446d34456c35456c36466c38476c39486c3a486c3b496c3c4a6c3d4a6c3e4b6c3f4c6c404c6c414d6c424e6c' +
    '434e6c444f6c45506c46516c47516c48526c49536c4a536c4b546c4c556c4d556c4e566c4f576c50576c51586d52596d' +
    '535a6d545a6d555b6d555c6d565c6d575d6d585e6d595e6e5a5f6e5b606e5c616e5d616e5e626e5e636f5f636f60646f' +
    '61656f62656f636670646770656870656870666970676a71686a71696b716a6c716b6d726c6d726c6e726d6f726e6f73' +
    '6f70737071737172747272747273747374757474757575757676767777767777777878777979777a7a787b7a787c7b78' +
    '7d7c787e7c787e7d787f7e78807f78817f788280798381798482798582798683798784788885788985788a86788b8778' +
    '8c88788d88788e89788f8a78908b78918b78928c78928d78938e78948e77958f779690779791779892779992779a9376' +
    '9b94769c95769d95769e96769f9775a09875a19975a29975a39a74a49b74a59c74a69c74a79d73a89e73a99f73aaa073' +
    'aba072aca172ada272aea371afa471b0a571b1a570b3a670b4a76fb5a86fb6a96fb7a96eb8aa6eb9ab6dbaac6dbbad6d' +
    'bcae6cbdae6cbeaf6bbfb06bc0b16ac1b26ac2b369c3b369c4b468c5b568c6b667c7b767c8b866c9b965cbb965ccba64' +
    'cdbb63cebc63cfbd62d0be62d1bf61d2c060d3c05fd4c15fd5c25ed6c35dd7c45cd9c55cdac65bdbc75adcc859ddc858' +
    'dec958dfca57e0cb56e1cc55e2cd54e4ce53e5cf52e6d051e7d150e8d24fe9d34eead34cebd44bedd54aeed649efd748' +
    'f0d846f1d945f2da44f3db42f5dc41f6dd3ff7de3ef8df3cf9e03afbe138fce236fde334fee434fee535fee636fee838',
};

export const PALETTE_NAMES = Object.freeze(['film', 'turbo', 'viridis', 'inferno', 'magma', 'plasma', 'cividis', 'grey', 'custom']);
export const WHITE_HOT_START_INDEX = 180; // buv::ColorMap::WHITE_HOT_START_INDEX
export const FILM_TRANSFER = Object.freeze({ offset: 30, upper: 500, gamma: 1 });
export const FILM_WHITE_HOT_BTC = 10; // whiteHotTailMinSatoshi 1,000,000,000 in configs/buv_explorer.json
export const MAX_GRADIENT_STOPS = 16;
export const DEFAULT_GRADIENT = Object.freeze([
  Object.freeze({ t: 0, color: '#0b1026' }),
  Object.freeze({ t: 0.35, color: '#2f6fd6' }),
  Object.freeze({ t: 0.7, color: '#f2b84b' }),
  Object.freeze({ t: 1, color: '#fff6e0' }),
]);

const decoded = new Map();
function table(name) {
  let rgb = decoded.get(name);
  if (!rgb) {
    const hex = TABLES[name];
    rgb = new Uint8Array(768);
    for (let i = 0; i < 768; i++) rgb[i] = parseInt(hex.substr(i * 2, 2), 16);
    decoded.set(name, rgb);
  }
  return rgb.slice();
}

function reversed(rgb) {
  const out = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    const j = 255 - i;
    out[i * 3] = rgb[j * 3];
    out[i * 3 + 1] = rgb[j * 3 + 1];
    out[i * 3 + 2] = rgb[j * 3 + 2];
  }
  return out;
}

// Base palette as Uint8Array(256 * 3). Unknown names fall back to "film".
// whiteHot: true returns the white-hot variant used on whale rows; for the film palette
// (not reversed) that is the exact palettes.json "whale" table.
export function paletteRGB(name, { gradient = null, reverse = false, whiteHot = false } = {}) {
  let rgb;
  if (name === 'film' && whiteHot && !reverse) return table('whale');
  if (name === 'custom') rgb = gradientRGB(gradient);
  else if (name === 'grey' || name === 'gray') {
    rgb = new Uint8Array(768);
    for (let i = 0; i < 256; i++) rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = i;
  } else rgb = table(Object.prototype.hasOwnProperty.call(TABLES, name) && name !== 'whale' ? name : 'film');
  if (reverse) rgb = reversed(rgb);
  if (whiteHot) rgb = applyWhiteHotTail(rgb);
  return rgb;
}

// The film's whale-row palette (palettes.json "whale").
export function whaleRGB({ reverse = false } = {}) {
  return paletteRGB('film', { reverse, whiteHot: true });
}

// Port of buv::ColorMap::applyWhiteHotTail (same double arithmetic and std::lround).
export function applyWhiteHotTail(rgb, startIdx = WHITE_HOT_START_INDEX) {
  const out = Uint8Array.from(rgb);
  const warm = [255.0, 245.0, 224.0];
  const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const startLuma = luminance(out[startIdx * 3], out[startIdx * 3 + 1], out[startIdx * 3 + 2]);
  const whiteLuma = luminance(warm[0], warm[1], warm[2]);
  for (let i = startIdx + 1; i < 256; ++i) {
    let t = (i - startIdx) / (255 - startIdx);
    t = t * t * (3.0 - 2.0 * t);
    const targetLuma = startLuma + (whiteLuma - startLuma) * t;
    const r = out[i * 3];
    const g = out[i * 3 + 1];
    const b = out[i * 3 + 2];
    const baseLuma = luminance(r, g, b);
    const denominator = whiteLuma - baseLuma;
    const alpha = denominator <= 0.0 ? 1.0 : Math.min(Math.max((targetLuma - baseLuma) / denominator, 0.0), 1.0);
    // Values are non-negative, where Math.round equals std::lround (half away from zero).
    out[i * 3] = Math.round(r + (warm[0] - r) * alpha);
    out[i * 3 + 1] = Math.round(g + (warm[1] - g) * alpha);
    out[i * 3 + 2] = Math.round(b + (warm[2] - b) * alpha);
  }
  return out;
}

// Colour value to [r, g, b] (0..255). Accepts '#rgb', '#rrggbb', 0xrrggbb or [r, g, b] in 0..255.
export function parseColor(c) {
  if (Array.isArray(c) || ArrayBuffer.isView(c)) return [c[0] | 0, c[1] | 0, c[2] | 0].map((x) => Math.min(255, Math.max(0, x)));
  if (typeof c === 'number' && Number.isFinite(c)) return [(c >> 16) & 255, (c >> 8) & 255, c & 255];
  if (typeof c === 'string') {
    let s = c.trim();
    if (s[0] === '#') s = s.slice(1);
    if (/^[0-9a-f]{3}$/i.test(s)) s = s.split('').map((x) => x + x).join('');
    if (/^[0-9a-f]{6}$/i.test(s)) {
      const n = parseInt(s, 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
  }
  return null;
}

// Sorted, validated stops: [{t, rgb}] with at most MAX_GRADIENT_STOPS entries.
export function normalizeGradient(stops) {
  const out = [];
  for (const s of Array.isArray(stops) ? stops : []) {
    const rgb = parseColor(s && s.color);
    const t = Number(s && s.t);
    if (!rgb || !Number.isFinite(t)) continue;
    out.push({ t: Math.min(1, Math.max(0, t)), rgb });
    if (out.length === MAX_GRADIENT_STOPS) break;
  }
  out.sort((a, b) => a.t - b.t);
  return out.length ? out : normalizeGradient(DEFAULT_GRADIENT);
}

// Custom gradient (linear interpolation in 8-bit sRGB between stops) as Uint8Array(768).
export function gradientRGB(stops) {
  const s = normalizeGradient(stops);
  const out = new Uint8Array(768);
  let k = 0;
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    while (k < s.length - 1 && s[k + 1].t <= t) k++;
    let rgb;
    if (t <= s[0].t) rgb = s[0].rgb;
    else if (k >= s.length - 1) rgb = s[s.length - 1].rgb;
    else {
      const a = s[k];
      const b = s[k + 1];
      const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
      rgb = [0, 1, 2].map((c) => a.rgb[c] + (b.rgb[c] - a.rgb[c]) * f);
    }
    out[i * 3] = Math.round(rgb[0]);
    out[i * 3 + 1] = Math.round(rgb[1]);
    out[i * 3 + 2] = Math.round(rgb[2]);
  }
  return out;
}

// Film transfer boundaries (offset 30, upper 500, gamma 1). Entry i - 1 is the smallest
// positive double whose buv::DensityToImage palette index is >= i, generated by bisection
// over double bit patterns with src/cpp/buv/DensityToImage.h compiled the way the renderer is
// (AppleClang 17, arm64, -O3, default -ffp-contract=on so LinearFunction's mK * x + mD is a
// fused multiply-add; Apple libm log). A plain JS formula differs from that code at a few
// hundred boundary doubles (FMA rounding and last-bit log differences), so the Film transfer
// uses this table. terrain-palette.test.mjs recompiles the C++ code and compares.
const FILM_BOUNDARY_HEX =
  '3ff58d82642116383ffb2aeec06a6f0940006c395851813840034b1e29a3f7c94006323d25818bf8400921ade012f769' +
  '400c198831144258400f19e434966ea94011116d25e1a6f540129a418ed1c41c4014277bcbf36d954015b92877d74b1c' +
  '40174f54512d2e1c4018ea0c3b2b972c401a895d3df864d5401c2d548712ae25401dd5ff69bdcc7c401f836b5f6d989c' +
  '40209ad30419ee934021765e959781ae4022545f5b7cfe76402334dc610eb753402417dcc5c10f6e4024fd67bd72564b' +
  '4025e58490a548e34026d03a9cbc3a964027bd915434e7a34028ad903ee4f2eb4029a03efa371146402a95a53968e403' +
  '402b8dcac5c984e3402c88b77ef8c4eb402d86735b2720ee402e870667566d1e402f8a78c79b39f3403048695baf7a5f' +
  '4030cd0e44d162ab4031532f54a195e64031dad0cc9e2fca403263f6fa77b9864032eea638341e5240337ae2ec520463' +
  '403408b189ec8b1b4034981690df6fa3403529168deb993e4035bbb61adc0e1240364ff9deab52274036e5e68da93156' +
  '40377d80e9a0f5a6403816cdc2000aef4038b1d1f3fd118640394e926abf609b4039ed141f86fa2e403a8d5c19d4f12b' +
  '403b2f6f6f94434f403bd3534543289b403c790cce1cd86f403d20a14c43c716403dca1610ec5be6403e75707c8821bf' +
  '403f22b5fef173ef403fd1ec1797a74a4040418c2ad5d96940409b202c26abd84040f5b4e75c654f4041514d3c3a705e' +
  '4041adec12c0e01340420b945b440b3340426a490e846b664042ca0d2dc6c04b40432ae3c2ec785240438ccfe08c5f0f' +
  '4043efd4a20b926a404453f52bb6bf9a4044b934aadba7f740451f9655e2ef764045871d6c6a34be4045efcd375e7406' +
  '404659a90916b5e74046c4b43d6f0a4e404730f239e3d0c640479e666dad4f5640480d1451db97d240487cff6972bdb7' +
  '4048ee2b41875c934049609b715b70024049d4539a7b7edf404a495768dc196f404abfaa92f7ac96404b3750d9ecaa36' +
  '404bb04e099c07f7404c2aa5f8c815db404ca65c8933ac8e404d2375a7c1b5c2404da1f54c950e6e404e21df7b30c482' +
  '404ea3384298b14b404f2603bd7270fa404faa461226b89640501801b98185fc40505ba00f2de9d34050a0002f576a90' +
  '4050e524456306bb40512b0e82ed77dd405171c11fdd04814051b93e5a7384e24052018877609b9e40524aa1c1d42261' +
  '4052948c8b90cb624052df4b2cfef88140532ae0053fc8024053774d7a4058464053c495f8cd4276405412bbf4a64d04' +
  '405461c1e89256d64054b1aa56737b5140550277c75b70194055542ccba01d744055a6cbfaf071504055fa57f4696e58' +
  '40564ed35eab77244056a440e7efd66c4056faa3461e8540405751fd36e42f2a4057aa517fc875eb405803a2ee4474b0' +
  '40585df457d983cd4058b9489a283e0a405915a29b07c76740597305489d57264059d173997404d3405a30f08c94d9af' +
  '405a917f299f273f405af32280e1235b405b55ddab70caca405bb9b3cb450b7b405c1ea80b4f3667405c84bd9f94bad3' +
  '405cebf7c5492b0b405d5459c2e88ba2405dbde6e851ee6f405e28a28ee25956405e9490198ffa97405f01b2f505aad2' +
  '405f700e97bebdce405fdfa68223235f4060283f1f51ec414060614cb0ebd4ff40609afdc54c24f24060d554310fdbe2' +
  '40611051ce12fee640614bf87b7fa1554061884a1ddd18d94061c5489f1f5d43406202f5eeb6941f40624154019ec925' +
  '40628064d26fd3874062c02a616d68c6406300a6b4975dd8406341dbd7ba1685406383cbdc7f243a4063c678da7e1449' +
  '406409e4ef4d6e4440644e123e93e35440649302f219ae894064d8b939da270340651f374c1584ae4065667f6562d78f' +
  '4065ae93c8c232eb4065f776bfaf0c434066412a9a32cef640668bb1aef7a55b4066d70e5b5b775d4067234303831fdb' +
  '40677052126dd8dc4067be3dfa08df6a40680d0933434ffc40685cb63e223b604068ad47a1d4f5a04068febfecc99ed2' +
  '40695121b4c1e6c64069a46f96e80c6d4069f8ac37e41938406a4dda43f15948406aa3fc6ef41176406afb15748f731d' +
  '406b5328183bcf47406bac37255d0928406c06456f5948ef406c6155d1afeff3406cbd6b3010ce37406d1a8876739ade' +
  '406d78b0992faf9b406dd7e69514082f406e382d6f7f86e2406e998836797e2e406efbfa00ca8122406f5f85ee157a9f' +
  '406fc42f26f10c6e407014fc6e809bb5407048732588a66a40707c7d5a9715074070b11cb4605fee4070e652de54728a' +
  '40711c2188ac3b694071528a687762fd4071898f37aa29ad4071c131b52b6dd54071f973a4e2d9ac40723256cfc73a19' +
  '40726bdd03ecfe6f4072a6081494e1b54072e0d9da3abe2440731c5432a48ad84073587900f184ca4073954a2da982fb' +
  '4073d2c9a6cc769c407410f95fe217cd40744fdb5209bf1040748f717c0a6c394074cfbde262fb72407510c28f5a886e' +
  '40755281931100da407594fd038fe6204075d836fcdb3f2540761c31a102badb407660ef1833038f4076a67190c7443a' +
  '4076ecbb3f5adfcf407733ce5edb5b4a40777bad309a7b5b4077c459fc60959440780dd7107f168340785826c1e33c93' +
  '4078a34b6c2908a94078ef4771ae653a40793c1d3ba6840d407989cf3a2d73814079d85fe45bec2f407a27d1b85b56eb' +
  '407a78273b7a0c91407ac962fa3fcf94407b1b8788828036407b6e97817b0c64407bc29587da9b25407c178445dff51e' +
  '407c6d666d6d2a2e407cc43eb81d7511407d1c0fe75b5e06407d74dcc4771c79407dcea820bd3943407e2974d58d717b' +
  '407e8545c471dada407ee21dd7364ac2407f400000000000';
export const FILM_BOUNDARIES = (() => {
  const out = new Float64Array(255);
  const u = new BigUint64Array(out.buffer);
  for (let i = 0; i < 255; i++) u[i] = BigInt('0x' + FILM_BOUNDARY_HEX.substr(i * 16, 16));
  return out;
})();

function isFilmTransfer(o) {
  return (o.offset ?? 30) === 30 && (o.upper ?? 500) === 500 && (o.gamma ?? 1) === 1;
}

/** Palette index by the JS formula (exact semantics of DensityToImage except for FMA and
 * last-bit log rounding at boundaries); used for non-film settings. */
export function transferIndexFormula(v, { offset = 30, upper = 500, gamma = 1 } = {}) {
  if (!(v > 0)) return -1;
  if (v >= upper) return 255;
  const x1 = Math.log(1 + offset);
  const x2 = Math.log(upper + offset);
  const k = (255 - 0) / (x2 - x1);
  const d = 0 - k * x1;
  const val = k * Math.log(v + offset) + d;
  let i;
  if (gamma === 1) i = Math.trunc(val);
  else i = Math.floor(255 * Math.pow(val <= 0 ? 0 : val >= 255 ? 1 : val / 255, gamma));
  return i <= 0 ? 0 : i >= 255 ? 255 : i;
}

// Palette index of a colour value, or -1 for the ground colour (v <= 0 or not a number).
// With the Film settings (offset 30, upper 500, gamma 1) this equals buv::DensityToImage
// exactly for every double (boundary table above). Other settings use
// t = clamp((ln(v + o) - ln(1 + o)) / (ln(U + o) - ln(1 + o)), 0, 1) ^ gamma, floor(255 t)
// (for gamma 1 the same LinearFunction form as the C++ code, truncated toward zero).
export function transferIndex(v, opts = {}) {
  if (!(v > 0)) return -1;
  if (!isFilmTransfer(opts)) return transferIndexFormula(v, opts);
  const B = FILM_BOUNDARIES;
  if (v < B[0]) return 0;
  let lo = 0; // B[lo] <= v
  let hi = 254;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (B[m] <= v) lo = m;
    else hi = m - 1;
  }
  return lo + 1;
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
function floatOfBits(bits) {
  u32[0] = bits;
  return f32[0];
}
function bitsOfFloat(x) {
  f32[0] = x;
  return u32[0];
}
/** Smallest float32 >= x (x positive and finite). */
function float32Ceil(x) {
  let f = Math.fround(x);
  if (f < x) f = floatOfBits(bitsOfFloat(f) + 1);
  return f;
}

// Float32Array(256) of thresholds for exact GPU evaluation: T[i] (i >= 1) is the smallest
// positive float32 v with transferIndex(v, opts) >= i, and T[0] = 0. For any positive
// float32 v the index is the largest i with T[i] <= v (thresholdIndex), so a shader that
// compares float32 values against T reproduces transferIndex bit for bit (and, with the Film
// settings, DensityToImage for every float32 density).
export function transferThresholds(opts = {}) {
  const T = new Float32Array(256);
  if (isFilmTransfer(opts)) {
    for (let i = 1; i < 256; i++) T[i] = float32Ceil(FILM_BOUNDARIES[i - 1]);
    return T;
  }
  const upper = opts.upper ?? 500;
  let hiBits = bitsOfFloat(upper);
  if (floatOfBits(hiBits) < upper) hiBits++;
  let lo = 1; // smallest positive float32 (denormal)
  for (let i = 1; i < 256; i++) {
    let a = lo;
    let b = hiBits;
    if (transferIndex(floatOfBits(b), opts) < i) {
      T[i] = floatOfBits(b);
      continue;
    }
    while (a < b) {
      const m = a + Math.floor((b - a) / 2);
      if (transferIndex(floatOfBits(m), opts) >= i) b = m;
      else a = m + 1;
    }
    T[i] = floatOfBits(a);
    lo = a;
  }
  return T;
}

// CPU emulation of the shader's binary search over transferThresholds().
export function thresholdIndex(T, v) {
  if (!(v > 0)) return -1;
  let lo = 0;
  for (let step = 128; step >= 1; step >>= 1) {
    const j = lo + step;
    if (j <= 255 && T[j] <= v) lo = j;
  }
  return lo;
}

// Last graph row (0 = largest amounts) that uses the white-hot palette, given rows.bin
// (minAmt, non-increasing) and the threshold in BTC: rows 0..whiteHotRow use it, as in
// buv::Density (override rows graphRect.y .. satoshiToPixelHeight(threshold)). Returns -1
// when the threshold is not positive or exceeds the axis maximum (palette inactive).
export function whiteHotRow(minAmt, btc, maxSatoshi = 10000000000000) {
  const sats = Math.round(Number(btc) * 1e8);
  if (!(sats > 0) || sats > maxSatoshi || !minAmt || !minAmt.length) return -1;
  // row(a) = min { r : a >= minAmt[r] } (SPEC section 4)
  let lo = 0;
  let hi = minAmt.length - 1;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (sats >= minAmt[m]) hi = m;
    else lo = m + 1;
  }
  return lo;
}

// Colour of one cell for 2D consumers (legend, minimap): [r, g, b] 0..255.
// ctx: {base, whale (Uint8Array 768), whiteRow, ground ([r,g,b]), transfer ({offset, upper, gamma})}
export function cellRGB(v, row, ctx) {
  const i = transferIndex(v, ctx.transfer || FILM_TRANSFER);
  if (i < 0) return ctx.ground || [0, 0, 0];
  const rgb = ctx.whale && row <= ctx.whiteRow ? ctx.whale : ctx.base;
  return [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]];
}
